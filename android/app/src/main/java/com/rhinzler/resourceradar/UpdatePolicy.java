package com.rhinzler.resourceradar;

import java.net.URI;
import java.net.URISyntaxException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Dependency-free update decisions. Certificate histories must come from Android's verified SigningInfo. */
public final class UpdatePolicy {
    private static final Pattern VERSION = Pattern.compile(
            "^[vV]?(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:\\.(\\d+))?(?:\\+(\\d+))?$");

    private UpdatePolicy() { }

    public enum ArchiveVersionDecision {
        MATCH, INVALID_VERSION, NOT_NEWER, RELEASE_NAME_MISMATCH, RELEASE_CODE_MISMATCH
    }

    public enum SignatureDecision {
        EXACT_MATCH, FORWARD_ROTATION, MISSING_SIGNERS, INCOMPATIBLE
    }

    /** Immutable numeric version; missing numeric components are zero, and +code is optional. */
    public static final class Version {
        private final long[] numbers;
        private final Long versionCode;

        private Version(long[] numbers, Long versionCode) {
            this.numbers = numbers;
            this.versionCode = versionCode;
        }

        public boolean hasVersionCode() { return versionCode != null; }
        public Long versionCode() { return versionCode; }

        public int compareNumeric(Version other) {
            if (other == null) throw new IllegalArgumentException("A numeric version is required.");
            for (int index = 0; index < numbers.length; index++) {
                int comparison = Long.compare(numbers[index], other.numbers[index]);
                if (comparison != 0) return comparison;
            }
            return 0;
        }
    }

    /** Accepts v1, 2, v2.1, 2.1.0, 2.1.0.1 and an optional numeric +versionCode. */
    public static Version parseVersion(String text) {
        if (text == null || text.length() > 128) return null;
        Matcher matcher = VERSION.matcher(text);
        if (!matcher.matches()) return null;
        try {
            long[] numbers = new long[4];
            for (int index = 0; index < numbers.length; index++) {
                numbers[index] = matcher.group(index + 1) == null ? 0 : Long.parseLong(matcher.group(index + 1));
            }
            Long code = matcher.group(5) == null ? null : Long.parseLong(matcher.group(5));
            return new Version(numbers, code);
        } catch (NumberFormatException exception) { return null; }
    }

    /** Invalid version strings fail closed with IllegalArgumentException, rather than implying an update. */
    public static boolean isNewer(String releaseTag, String installedName, long installedCode) {
        Version release = parseVersion(releaseTag);
        Version installed = parseVersion(installedName);
        if (release == null || installed == null || installedCode < 0) {
            throw new IllegalArgumentException("The release version cannot be compared.");
        }
        if (release.hasVersionCode() && release.versionCode <= installedCode) return false;
        int comparison = release.compareNumeric(installed);
        return comparison > 0 || (comparison == 0 && release.hasVersionCode()
                && release.versionCode > installedCode);
    }

    /** The advertised numeric name must match exactly after zero-padding; +code constrains the real code. */
    public static ArchiveVersionDecision archiveVersionDecision(String releaseTag, String archiveName,
                                                                long archiveCode, String installedName,
                                                                long installedCode) {
        Version release = parseVersion(releaseTag);
        Version archive = parseVersion(archiveName);
        Version installed = parseVersion(installedName);
        if (release == null || archive == null || installed == null || archiveCode < 0 || installedCode < 0) {
            return ArchiveVersionDecision.INVALID_VERSION;
        }
        if (archive.compareNumeric(release) != 0) return ArchiveVersionDecision.RELEASE_NAME_MISMATCH;
        if (release.hasVersionCode() && release.versionCode != archiveCode) {
            return ArchiveVersionDecision.RELEASE_CODE_MISMATCH;
        }
        if (archiveCode <= installedCode || archive.compareNumeric(installed) < 0) {
            return ArchiveVersionDecision.NOT_NEWER;
        }
        return ArchiveVersionDecision.MATCH;
    }

    /** Validates the exact initial GitHub repository/tag/asset path, without network or URL normalization. */
    public static boolean isReleaseAssetUrl(String raw, String tag, String assetName) {
        if (raw == null || raw.length() > 4096 || parseVersion(tag) == null
                || assetName == null || assetName.length() > 180 || assetName.contains("/")
                || assetName.contains("\\") || !assetName.toLowerCase(Locale.US).endsWith(".apk")) return false;
        for (int index = 0; index < assetName.length(); index++) {
            if (Character.isISOControl(assetName.charAt(index))) return false;
        }
        try {
            URI uri = new URI(raw);
            if (!"https".equals(uri.getScheme()) || !"github.com".equalsIgnoreCase(uri.getHost())
                    || (uri.getPort() != -1 && uri.getPort() != 443) || uri.getRawUserInfo() != null
                    || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || !uri.getRawPath().equals(uri.normalize().getRawPath())) return false;
            // Decode the path only after parsing. Encoded slashes/traversal cannot become extra accepted components.
            String[] segments = uri.getPath().split("/", -1);
            return segments.length == 7 && segments[0].isEmpty() && "SRhinzler".equals(segments[1])
                    && "resource-radar".equals(segments[2]) && "releases".equals(segments[3])
                    && "download".equals(segments[4]) && tag.equals(segments[5]) && assetName.equals(segments[6]);
        } catch (URISyntaxException | IllegalArgumentException exception) { return false; }
    }

    /** A missing digest is optional; malformed nonempty digests never match. */
    public static boolean matchesSha256(String expectedHex, byte[] actualDigest) {
        if (actualDigest == null || actualDigest.length != 32) return false;
        if (expectedHex == null || expectedHex.isEmpty()) return true;
        if (!expectedHex.matches("(?i)[a-f0-9]{64}")) return false;
        byte[] expected = new byte[32];
        for (int index = 0; index < expected.length; index++) {
            expected[index] = (byte) Integer.parseInt(expectedHex.substring(index * 2, index * 2 + 2), 16);
        }
        return MessageDigest.isEqual(expected, actualDigest);
    }

    /**
     * Multi-signer APKs require identical current signer sets. Single-signer rotation is forward-only:
     * the installed current signer must precede the archive current signer in Android's verified lineage.
     * Never pass a history parsed from renderer data, release notes, or an unverified certificate file.
     * Android remains responsible for lineage capabilities and final installation authorization.
     */
    public static SignatureDecision signatureDecision(byte[][] installedCurrent, byte[][] archiveCurrent,
                                                       byte[][] verifiedArchiveHistory) {
        Set<String> installed = certificateSet(installedCurrent);
        Set<String> archive = certificateSet(archiveCurrent);
        if (installed == null || archive == null) return SignatureDecision.MISSING_SIGNERS;
        if (installed.equals(archive)) return SignatureDecision.EXACT_MATCH;
        if (installed.size() != 1 || archive.size() != 1 || verifiedArchiveHistory == null
                || verifiedArchiveHistory.length < 2 || certificateSet(verifiedArchiveHistory) == null
                || !Arrays.equals(verifiedArchiveHistory[verifiedArchiveHistory.length - 1], archiveCurrent[0])) {
            return SignatureDecision.INCOMPATIBLE;
        }
        for (int index = 0; index < verifiedArchiveHistory.length - 1; index++) {
            if (Arrays.equals(installedCurrent[0], verifiedArchiveHistory[index])) {
                return SignatureDecision.FORWARD_ROTATION;
            }
        }
        return SignatureDecision.INCOMPATIBLE;
    }

    /** Canonical current-signer identity for an internal verification receipt; empty means unavailable. */
    public static String signerIdentity(byte[][] current) {
        Set<String> certificates = certificateSet(current);
        return certificates == null ? "" : String.join(":", new TreeSet<>(certificates));
    }

    public static String hex(byte[] bytes) {
        if (bytes == null) return "";
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte part : bytes) value.append(String.format(Locale.US, "%02x", part & 255));
        return value.toString();
    }

    private static Set<String> certificateSet(byte[][] certificates) {
        if (certificates == null || certificates.length == 0) return null;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            Set<String> result = new HashSet<>();
            for (byte[] certificate : certificates) {
                if (certificate == null || certificate.length == 0 || !result.add(hex(digest.digest(certificate)))) return null;
            }
            return result;
        } catch (NoSuchAlgorithmException exception) { throw new IllegalStateException("SHA-256 is unavailable.", exception); }
    }
}
