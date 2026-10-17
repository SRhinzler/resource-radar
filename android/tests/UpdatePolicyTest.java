package com.rhinzler.resourceradar;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import static com.rhinzler.resourceradar.UpdatePolicy.ArchiveVersionDecision.*;
import static com.rhinzler.resourceradar.UpdatePolicy.SignatureDecision.*;

/** Host-JDK regression checks; intentionally dependency-free, not a device/PackageManager test. */
public final class UpdatePolicyTest {
    private static int checks;
    private static void check(boolean condition, String message) {
        checks++;
        if (!condition) throw new AssertionError(message);
    }
    public static void main(String[] args) throws Exception {
        check(!UpdatePolicy.isNewer("v1", "2.0", 2), "No downgrade to v1");
        check(!UpdatePolicy.isNewer("v2", "2.0.0", 2), "Short equal tag");
        check(UpdatePolicy.isNewer("v2.1", "2.0", 2), "New minor version");
        check(UpdatePolicy.isNewer("v10", "2.0", 2), "Numeric, not lexical comparison");
        check(UpdatePolicy.isNewer("v2.0+3", "2.0", 2), "Android code-only update");
        check(!UpdatePolicy.isNewer("v2.1+2", "2.0", 2), "Explicit old code rejected");
        check(!UpdatePolicy.isNewer("v1+99", "2.0", 2), "Higher code cannot downgrade name");
        for (String invalid : new String[]{"", "release-next", "v2-beta", "v-2", "2.0.0.0.0", "2+abc", "https://example.com", "99999999999999999999999999"}) {
            check(UpdatePolicy.parseVersion(invalid) == null, "Reject invalid tag: " + invalid);
        }
        check(UpdatePolicy.archiveVersionDecision("v2.1", "2.1.0", 3, "2.0", 2) == MATCH, "Name zero padding");
        check(UpdatePolicy.archiveVersionDecision("v2.1+3", "2.1", 3, "2.0", 2) == MATCH, "Exact code match");
        check(UpdatePolicy.archiveVersionDecision("v2.1+4", "2.1", 3, "2.0", 2) == RELEASE_CODE_MISMATCH, "Tag code mismatch");
        check(UpdatePolicy.archiveVersionDecision("v3", "2.1", 3, "2.0", 2) == RELEASE_NAME_MISMATCH, "Misadvertised APK name");
        check(UpdatePolicy.archiveVersionDecision("v2.1", "2.1", 2, "2.0", 2) == NOT_NEWER, "Code must increase");
        check(UpdatePolicy.archiveVersionDecision("v1", "1.0", 9, "2.0", 2) == NOT_NEWER, "Archive downgrade rejected");

        String base = "https://github.com/SRhinzler/resource-radar/releases/download/v2.1/";
        String name = "Resource-Radar-Android-2.1.apk";
        String url = base + name;
        check(UpdatePolicy.isReleaseAssetUrl(url, "v2.1", name), "Correct release asset");
        check(!UpdatePolicy.isReleaseAssetUrl(url, "v3", name), "Wrong tag");
        check(!UpdatePolicy.isReleaseAssetUrl(url, "v2.1", "other.apk"), "Wrong name");
        for (String bad : new String[]{
                url.replace("https:", "http:"), url.replace("github.com/", "user@github.com/"),
                url.replace("github.com/", "github.com:444/"), url + "?x=1", url + "#fragment",
                url.replace("SRhinzler", "other"), url.replace("github.com", "github.com.evil.example"),
                base + "../" + name, base + "%2e%2e/" + name, base + "path%2f" + name,
                url.replace("github.com", "release-assets.githubusercontent.com"), "file:///tmp/test.apk"
        }) check(!UpdatePolicy.isReleaseAssetUrl(bad, "v2.1", name), "Reject URL: " + bad);

        byte[] digest = MessageDigest.getInstance("SHA-256").digest("test apk".getBytes(StandardCharsets.UTF_8));
        check(UpdatePolicy.matchesSha256(UpdatePolicy.hex(digest), digest), "Correct digest");
        check(UpdatePolicy.matchesSha256(UpdatePolicy.hex(digest).toUpperCase(), digest), "Case-insensitive digest");
        check(UpdatePolicy.matchesSha256("", digest), "Optional missing digest");
        check(!UpdatePolicy.matchesSha256("0".repeat(64), digest), "Wrong digest rejected");
        check(!UpdatePolicy.matchesSha256("bad", digest), "Malformed digest rejected");
        check(!UpdatePolicy.matchesSha256("", new byte[0]), "Bad computed digest rejected");

        byte[] oldSigner = new byte[]{1, 2, 3};
        byte[] newSigner = new byte[]{4, 5, 6};
        byte[] foreign = new byte[]{7, 8, 9};
        check(UpdatePolicy.signatureDecision(new byte[][]{oldSigner}, new byte[][]{oldSigner}, null) == EXACT_MATCH, "Same signer");
        check(UpdatePolicy.signatureDecision(new byte[][]{oldSigner}, new byte[][]{newSigner}, new byte[][]{oldSigner, newSigner}) == FORWARD_ROTATION, "Verified forward rotation");
        check(UpdatePolicy.signatureDecision(new byte[][]{newSigner}, new byte[][]{oldSigner}, new byte[][]{oldSigner, newSigner}) == INCOMPATIBLE, "No reverse rotation");
        check(UpdatePolicy.signatureDecision(new byte[][]{foreign}, new byte[][]{newSigner}, new byte[][]{oldSigner, newSigner}) == INCOMPATIBLE, "Unrelated signer");
        check(UpdatePolicy.signatureDecision(new byte[][]{oldSigner}, new byte[][]{newSigner}, null) == INCOMPATIBLE, "No invented lineage");
        check(UpdatePolicy.signatureDecision(new byte[][]{oldSigner, newSigner}, new byte[][]{newSigner, oldSigner}, null) == EXACT_MATCH, "Multi-signer unordered equality");
        check(UpdatePolicy.signatureDecision(new byte[][]{oldSigner, newSigner}, new byte[][]{newSigner}, null) == INCOMPATIBLE, "Multi-signer subset rejected");
        check(UpdatePolicy.signatureDecision(null, new byte[][]{oldSigner}, null) == MISSING_SIGNERS, "Missing signer rejected");
        check(UpdatePolicy.signatureDecision(new byte[][]{oldSigner}, new byte[][]{new byte[0]}, null) == MISSING_SIGNERS, "Empty signer rejected");
        check(UpdatePolicy.signerIdentity(new byte[][]{oldSigner, newSigner}).equals(UpdatePolicy.signerIdentity(new byte[][]{newSigner, oldSigner})), "Stable identity order");
        System.out.println("UpdatePolicy: " + checks + " assertions passed");
    }
}
