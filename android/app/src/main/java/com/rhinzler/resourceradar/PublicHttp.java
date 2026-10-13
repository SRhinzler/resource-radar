package com.rhinzler.resourceradar;

import okhttp3.Call;
import okhttp3.ConnectionSpec;
import okhttp3.Dns;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.Proxy;
import java.net.UnknownHostException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadPoolExecutor;

/**
 * Small, deliberately restrictive HTTP client used by Resource Radar.
 *
 * <p>OkHttp's normal automatic redirect handling is disabled.  Every redirect is
 * resolved one hop at a time, checked for HTTPS and public DNS addresses, and only
 * then requested.  This matters for both page scans and short-link resolution: a
 * public URL must never be allowed to turn into a request for loopback, private, or
 * link-local space.</p>
 */
public final class PublicHttp implements Closeable {
    public static final long MAX_PAGE_BYTES = 8L * 1024L * 1024L;
    public static final int MAX_REDIRECTS = 8;
    private static final int BUFFER_SIZE = 32 * 1024;
    private static final String USER_AGENT = "ResourceRadar/1.0 (Android; public resources only)";
    private static final ThreadPoolExecutor RESOLVER = new ThreadPoolExecutor(0, 4, 30, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(16), runnable -> {
                Thread thread = new Thread(runnable, "resource-radar-dns");
                thread.setDaemon(true);
                return thread;
            });

    private final OkHttpClient client;
    private final OkHttpClient streamClient;

    public PublicHttp() {
        client = new OkHttpClient.Builder()
                .dns(new PublicDns())
                .proxy(Proxy.NO_PROXY)
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .callTimeout(45, TimeUnit.SECONDS)
                .followRedirects(false)
                .followSslRedirects(false)
                .connectionSpecs(Collections.singletonList(ConnectionSpec.RESTRICTED_TLS))
                .build();
        streamClient = client.newBuilder().callTimeout(6, TimeUnit.HOURS).build();
    }

    /** Fetches a bounded HTML/text page after following only safe redirects. */
    public Page fetchPage(String rawUrl, CallTracker tracker) throws IOException {
        HttpUrl current = requirePublicHttps(rawUrl);
        for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            Request request = requestFor(current).get().build();
            Call call = client.newCall(request);
            trackAdd(tracker, call);
            Response response = null;
            try {
                response = call.execute();
                int code = response.code();
                if (isRedirect(code)) {
                    String location = response.header("Location");
                    if (location == null || location.trim().isEmpty()) {
                        throw new PublicHttpException("The public page redirect was invalid.", "BAD_REDIRECT");
                    }
                    current = requireRedirect(current, location);
                    continue;
                }
                if (code < 200 || code >= 300) {
                    throw new PublicHttpException("The public page could not be fetched.", "HTTP_" + code);
                }
                ResponseBody body = response.body();
                if (body == null) {
                    throw new PublicHttpException("The public page returned no content.", "EMPTY_BODY");
                }
                long declaredLength = body.contentLength();
                if (declaredLength > MAX_PAGE_BYTES) {
                    throw new PublicHttpException("The page is larger than the 8 MiB scan limit.", "PAGE_TOO_LARGE");
                }
                byte[] bytes = readLimited(body.byteStream(), MAX_PAGE_BYTES);
                Charset charset = StandardCharsets.UTF_8;
                if (body.contentType() != null && body.contentType().charset(StandardCharsets.UTF_8) != null) {
                    charset = body.contentType().charset(StandardCharsets.UTF_8);
                }
                return new Page(current, new String(bytes, charset), response.header("Content-Type"));
            } finally {
                if (response != null) {
                    response.close();
                }
                trackRemove(tracker, call);
            }
        }
        throw new PublicHttpException("Too many public redirects.", "TOO_MANY_REDIRECTS");
    }

    /** Convenience overload for callers that do not need cancellation tracking. */
    public Page fetchPage(String rawUrl) throws IOException {
        return fetchPage(rawUrl, null);
    }

    /**
     * Resolves redirects with safe GET requests and returns the final URL.  The final
     * response body is not read; this method is intended for short-link/platform URL
     * canonicalization, not page discovery.
     */
    public HttpUrl resolveRedirects(String rawUrl, CallTracker tracker) throws IOException {
        HttpUrl current = requirePublicHttps(rawUrl);
        for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            Request request = requestFor(current).get().build();
            Call call = client.newCall(request);
            trackAdd(tracker, call);
            Response response = null;
            try {
                response = call.execute();
                int code = response.code();
                if (isRedirect(code)) {
                    String location = response.header("Location");
                    if (location == null || location.trim().isEmpty()) {
                        throw new PublicHttpException("The public redirect did not include a destination.", "BAD_REDIRECT");
                    }
                    current = requireRedirect(current, location);
                    continue;
                }
                if (code < 200 || code >= 400) {
                    throw new PublicHttpException("The public URL could not be resolved.", "HTTP_" + code);
                }
                return current;
            } finally {
                if (response != null) {
                    response.close();
                }
                trackRemove(tracker, call);
            }
        }
        throw new PublicHttpException("Too many public redirects.", "TOO_MANY_REDIRECTS");
    }

    public HttpUrl resolveRedirects(String rawUrl) throws IOException {
        return resolveRedirects(rawUrl, null);
    }

    /** Opens a streamed GET.  The caller must close the returned response. */
    public StreamResponse openStream(String rawUrl, CallTracker tracker) throws IOException {
        HttpUrl current = requirePublicHttps(rawUrl);
        for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            Request request = requestFor(current).get().build();
            Call call = streamClient.newCall(request);
            trackAdd(tracker, call);
            Response response = null;
            boolean handedOff = false;
            try {
                response = call.execute();
                int code = response.code();
                if (isRedirect(code)) {
                    String location = response.header("Location");
                    if (location == null || location.trim().isEmpty()) {
                        throw new PublicHttpException("The public download redirect was invalid.", "BAD_REDIRECT");
                    }
                    current = requireRedirect(current, location);
                    continue;
                }
                if (code < 200 || code >= 300) {
                    throw new PublicHttpException("The public download could not be fetched.", "HTTP_" + code);
                }
                ResponseBody body = response.body();
                if (body == null) {
                    throw new PublicHttpException("The public download returned no content.", "EMPTY_BODY");
                }
                handedOff = true;
                return new StreamResponse(
                        current,
                        call,
                        response,
                        body.byteStream(),
                        body.contentLength(),
                        response.header("Content-Type"),
                        response.header("Content-Disposition"),
                        tracker
                );
            } finally {
                if (!handedOff) {
                    if (response != null) {
                        response.close();
                    }
                    trackRemove(tracker, call);
                }
            }
        }
        throw new PublicHttpException("Too many public redirects.", "TOO_MANY_REDIRECTS");
    }

    public StreamResponse openStream(String rawUrl) throws IOException {
        return openStream(rawUrl, null);
    }

    /** Returns the parsed HTTPS URL only when its host resolves exclusively publicly. */
    public static HttpUrl requirePublicHttps(String rawUrl) throws IOException {
        HttpUrl url = parseHttps(rawUrl);
        resolvePublicAddresses(url.host());
        return url;
    }

    /** Nonblocking URL validation. DNS is rechecked by the worker before connecting. */
    static HttpUrl parseHttps(String rawUrl) throws IOException {
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            throw new PublicHttpException("Enter a public HTTPS URL first.", "INVALID_URL");
        }
        HttpUrl url = HttpUrl.parse(rawUrl.trim());
        if (url == null || !"https".equalsIgnoreCase(url.scheme())) {
            throw new PublicHttpException("Only public HTTPS URLs are supported.", "INVALID_URL");
        }
        if (url.host().trim().isEmpty() || !url.username().isEmpty() || !url.password().isEmpty()) {
            throw new PublicHttpException("HTTPS URLs may not contain embedded credentials.", "INVALID_URL");
        }
        if (isLocalName(url.host())) {
            throw new PublicHttpException("Local and private network addresses are not supported.", "PRIVATE_URL");
        }
        return url.newBuilder().fragment(null).build();
    }

    /** Syntactic and DNS public-address check used by scanners before exposing a candidate. */
    public static boolean isPublicUrl(String rawUrl) {
        try {
            requirePublicHttps(rawUrl);
            return true;
        } catch (IOException | RuntimeException ignored) {
            return false;
        }
    }

    /** Resolves all A/AAAA answers and rejects a hostname with any non-public answer. */
    public static boolean isPublicHost(String rawHost) {
        try {
            resolvePublicAddresses(rawHost);
            return true;
        } catch (IOException | RuntimeException ignored) {
            return false;
        }
    }

    static boolean isLocalName(String rawHost) {
        if (rawHost == null || rawHost.trim().isEmpty()) {
            return true;
        }
        String host = rawHost.trim().toLowerCase(Locale.US);
        while (host.endsWith(".")) {
            host = host.substring(0, host.length() - 1);
        }
        return host.isEmpty() || host.equals("localhost") || host.endsWith(".localhost")
                || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")
                || host.endsWith(".home") || host.endsWith(".test") || host.endsWith(".invalid")
                || host.contains("%");
    }

    static List<InetAddress> resolvePublicAddresses(String host) throws UnknownHostException {
        if (isLocalName(host)) {
            throw new UnknownHostException("Public address policy rejected the hostname.");
        }
        Future<InetAddress[]> lookup = null;
        try {
            lookup = RESOLVER.submit(() -> InetAddress.getAllByName(host));
            InetAddress[] addresses = lookup.get(8, TimeUnit.SECONDS);
            if (addresses.length == 0) {
                throw new UnknownHostException("The public hostname did not resolve.");
            }
            for (InetAddress address : addresses) {
                if (!isPublicAddress(address)) {
                    throw new UnknownHostException("Public address policy rejected the DNS answer.");
                }
            }
            return Collections.unmodifiableList(Arrays.asList(addresses));
        } catch (Exception exception) {
            if (exception instanceof InterruptedException) Thread.currentThread().interrupt();
            if (exception instanceof UnknownHostException) throw (UnknownHostException) exception;
            throw new UnknownHostException("The public hostname could not be resolved safely within the time limit.");
        } finally {
            if (lookup != null && !lookup.isDone()) lookup.cancel(true);
        }
    }

    /** Package-level test seam for IPv4/IPv6 address policy. */
    static boolean isPublicAddress(InetAddress address) {
        if (address == null || address.isAnyLocalAddress() || address.isLoopbackAddress()
                || address.isLinkLocalAddress() || address.isSiteLocalAddress()
                || address.isMulticastAddress()) {
            return false;
        }
        byte[] bytes = address.getAddress();
        if (address instanceof Inet4Address && bytes.length == 4) {
            int a = bytes[0] & 0xff;
            int b = bytes[1] & 0xff;
            int c = bytes[2] & 0xff;
            if (a == 0 || a == 10 || a == 127 || a >= 224
                    || (a == 100 && b >= 64 && b <= 127)
                    || (a == 169 && b == 254)
                    || (a == 172 && b >= 16 && b <= 31)
                    || (a == 192 && b == 168)
                    || (a == 192 && b == 0 && c == 0)
                    || (a == 192 && b == 0 && c == 2)
                    || (a == 192 && b == 88 && c == 99)
                    || (a == 198 && (b == 18 || b == 19))
                    || (a == 198 && b == 51 && c == 100)
                    || (a == 203 && b == 0 && c == 113)) {
                return false;
            }
            return true;
        }
        if (address instanceof Inet6Address && bytes.length == 16) {
            int first = bytes[0] & 0xff;
            int second = bytes[1] & 0xff;
            // fc00::/7 unique-local and fe80::/10 link-local are denied even if
            // the platform does not classify an unusual textual form for us.
            if ((first & 0xfe) == 0xfc || (first == 0xfe && (second & 0xc0) == 0x80)) {
                return false;
            }
            // IPv4-mapped IPv6 addresses inherit IPv4 policy.
            boolean mapped = true;
            for (int index = 0; index < 10; index++) {
                if (bytes[index] != 0) {
                    mapped = false;
                    break;
                }
            }
            if (mapped && bytes[10] == (byte) 0xff && bytes[11] == (byte) 0xff) {
                try {
                    return isPublicAddress(InetAddress.getByAddress(Arrays.copyOfRange(bytes, 12, 16)));
                } catch (UnknownHostException ignored) {
                    return false;
                }
            }
            // Android networks that are IPv6-only commonly synthesize the
            // well-known NAT64 address 64:ff9b::/96 for an IPv4 destination.
            // Validate the embedded IPv4 address with the same policy instead
            // of rejecting every translated public Dailymotion/CDN endpoint.
            if (isWellKnownNat64(bytes)) {
                try {
                    return isPublicAddress(InetAddress.getByAddress(Arrays.copyOfRange(bytes, 12, 16)));
                } catch (UnknownHostException ignored) {
                    return false;
                }
            }
            // Only globally routed unicast is accepted. This also excludes IPv4
            // compatible, discard-only, multicast and unspecified ranges.
            if ((first & 0xe0) != 0x20) return false;
            if (first == 0x20 && second == 0x02) return false; // 6to4 embeds an IPv4 destination.
            if (first == 0x20 && second == 0x01) {
                int third = bytes[2] & 0xff;
                int fourth = bytes[3] & 0xff;
                if (third < 2 || (third == 0x0d && fourth == 0xb8)) return false;
            }
            return true;
        }
        return false;
    }

    private static boolean isWellKnownNat64(byte[] bytes) {
        return bytes != null && bytes.length == 16
                && (bytes[0] & 0xff) == 0x00
                && (bytes[1] & 0xff) == 0x64
                && (bytes[2] & 0xff) == 0xff
                && (bytes[3] & 0xff) == 0x9b
                && bytes[4] == 0 && bytes[5] == 0 && bytes[6] == 0 && bytes[7] == 0
                && bytes[8] == 0 && bytes[9] == 0 && bytes[10] == 0 && bytes[11] == 0;
    }

    /** Validates one redirect location relative to the current public URL. */
    static HttpUrl requireRedirect(HttpUrl current, String location) throws IOException {
        if (current == null || location == null || location.trim().isEmpty()) {
            throw new PublicHttpException("The public redirect was invalid.", "BAD_REDIRECT");
        }
        HttpUrl target = current.resolve(location.trim());
        if (target == null) {
            throw new PublicHttpException("The public redirect was invalid.", "BAD_REDIRECT");
        }
        return requirePublicHttps(target.toString());
    }

    private Request.Builder requestFor(HttpUrl url) {
        return new Request.Builder()
                .url(url)
                .header("User-Agent", USER_AGENT)
                .header("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1")
                .header("Cache-Control", "no-cache");
    }

    private static boolean isRedirect(int code) {
        return code == 300 || code == 301 || code == 302 || code == 303 || code == 307 || code == 308;
    }

    private static byte[] readLimited(InputStream input, long maximum) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[BUFFER_SIZE];
        long total = 0;
        int count;
        while ((count = input.read(buffer)) != -1) {
            total += count;
            if (total > maximum) {
                throw new PublicHttpException("The page is larger than the 8 MiB scan limit.", "PAGE_TOO_LARGE");
            }
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private static void trackAdd(CallTracker tracker, Call call) {
        if (tracker != null && call != null) {
            tracker.add(call);
        }
    }

    private static void trackRemove(CallTracker tracker, Call call) {
        if (tracker != null && call != null) {
            tracker.remove(call);
        }
    }

    @Override
    public void close() {
        client.dispatcher().cancelAll();
        client.dispatcher().executorService().shutdownNow();
        client.connectionPool().evictAll();
        if (client.cache() != null) {
            try {
                client.cache().close();
            } catch (IOException ignored) {
                // Closing a process-owned cache cannot affect the download result.
            }
        }
    }

    /** Receives each OkHttp call so a download job can cancel it. */
    public interface CallTracker {
        void add(Call call);

        void remove(Call call);
    }

    public static final class Page {
        private final HttpUrl url;
        private final String body;
        private final String contentType;

        Page(HttpUrl url, String body, String contentType) {
            this.url = url;
            this.body = body;
            this.contentType = contentType;
        }

        public HttpUrl url() {
            return url;
        }

        public String body() {
            return body;
        }

        public String contentType() {
            return contentType;
        }
    }

    public static final class StreamResponse implements Closeable {
        private final HttpUrl url;
        private final Call call;
        private final Response response;
        private final InputStream stream;
        private final long contentLength;
        private final String contentType;
        private final String contentDisposition;
        private final CallTracker tracker;
        private boolean closed;

        StreamResponse(HttpUrl url, Call call, Response response, InputStream stream,
                       long contentLength, String contentType, String contentDisposition,
                       CallTracker tracker) {
            this.url = url;
            this.call = call;
            this.response = response;
            this.stream = stream;
            this.contentLength = contentLength;
            this.contentType = contentType;
            this.contentDisposition = contentDisposition;
            this.tracker = tracker;
        }

        public HttpUrl url() {
            return url;
        }

        public InputStream stream() {
            return stream;
        }

        public long contentLength() {
            return contentLength;
        }

        public String contentType() {
            return contentType;
        }

        public String contentDisposition() {
            return contentDisposition;
        }

        public Call call() {
            return call;
        }

        @Override
        public synchronized void close() {
            if (closed) {
                return;
            }
            closed = true;
            try {
                response.close();
            } finally {
                trackRemove(tracker, call);
            }
        }
    }

    public static class PublicHttpException extends IOException {
        private final String code;

        PublicHttpException(String message, String code) {
            super(message);
            this.code = code == null ? "HTTP_FAILED" : code;
        }

        public String code() {
            return code;
        }
    }

    private static final class PublicDns implements Dns {
        @Override
        public List<InetAddress> lookup(String hostname) throws UnknownHostException {
            return resolvePublicAddresses(hostname);
        }
    }
}
