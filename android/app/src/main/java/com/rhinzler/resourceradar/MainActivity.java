package com.rhinzler.resourceradar;

import android.Manifest;
import android.content.res.AssetManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Hosts the local Resource Radar UI and its production native service bridge. */
public final class MainActivity extends ComponentActivity {
    private static final String LOCAL_ASSET_ORIGIN = "https://appassets.androidplatform.net/assets/";
    private static final int POST_NOTIFICATIONS_REQUEST = 7101;
    private static final int MAX_LAUNCH_TEXT_LENGTH = 4096;
    private static final Pattern HTTPS_URL_PATTERN = Pattern.compile("https://[^\\s<>\\\"']+", Pattern.CASE_INSENSITIVE);

    private WebView webView;
    private ResourceRadarBridge bridge;
    private NativeResourceService nativeService;
    private String pendingLaunchUrl;
    private boolean pageLoaded;
    private boolean notificationPermissionRequested;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureWindow();

        webView = new WebView(this);
        configureWebView(webView);

        nativeService = new NativeResourceService(this);
        bridge = new ResourceRadarBridge(this, webView, nativeService);
        webView.addJavascriptInterface(bridge, ResourceRadarBridge.JAVASCRIPT_INTERFACE_NAME);
        setContentView(webView);
        webView.loadUrl(LOCAL_ASSET_ORIGIN + "index.html");
        // Lifecycle ownership removes this callback when the Activity is destroyed.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleWebViewBack();
            }
        });

        // Permission denial is deliberately non-blocking.  The backend remains
        // responsible for the foreground-service notification if permission is not
        // granted, while Android gives the user a normal runtime prompt at startup.
        requestNotificationPermissionIfNeeded();
        handleLaunchIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleLaunchIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        UpdateManager.get(this).attach(this);
        if (pageLoaded && webView != null) {
            try {
                webView.evaluateJavascript("window.resourceRadar && window.resourceRadar.__resume();", null);
            } catch (RuntimeException ignored) {
                // A dead renderer must not prevent the Activity from resuming.
            }
        }
    }

    @Override
    protected void onPause() {
        UpdateManager.get(this).detach(this);
        super.onPause();
    }

    private void configureWindow() {
        Window window = getWindow();
        window.setStatusBarColor(Color.rgb(247, 248, 252));
        window.setNavigationBarColor(Color.rgb(247, 248, 252));
        int systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            systemUiVisibility |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        window.getDecorView().setSystemUiVisibility(systemUiVisibility);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
        }
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // The only permitted resource origin is the APK asset loader below.  Content
        // URIs and file-to-file/universal access are disabled independently.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        view.setBackgroundColor(Color.rgb(247, 248, 252));
        view.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        view.setWebViewClient(new LocalOnlyWebViewClient());
        view.setOnApplyWindowInsetsListener((target, insets) -> {
            int left;
            int top;
            int right;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets safeInsets = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
                );
                left = safeInsets.left;
                top = safeInsets.top;
                right = safeInsets.right;
                bottom = safeInsets.bottom;
            } else {
                left = insets.getSystemWindowInsetLeft();
                top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
            }
            target.setPadding(left, top, right, bottom);
            return insets;
        });
        view.requestApplyInsets();
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || notificationPermissionRequested
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        notificationPermissionRequested = true;
        try {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, POST_NOTIFICATIONS_REQUEST);
        } catch (RuntimeException ignored) {
            // A denied or unavailable runtime prompt must never block the UI.
        }
    }

    private void handleLaunchIntent(Intent intent) {
        String safeUrl = extractSafeLaunchUrl(intent);
        if (safeUrl == null) {
            return;
        }
        pendingLaunchUrl = safeUrl;
        dispatchLaunchUrlIfReady();
    }

    private void dispatchLaunchUrlIfReady() {
        if (!pageLoaded || webView == null || TextUtils.isEmpty(pendingLaunchUrl)) {
            return;
        }
        String url = pendingLaunchUrl;
        pendingLaunchUrl = null;
        try {
            webView.evaluateJavascript(
                    "window.resourceRadar && window.resourceRadar.__receiveLaunchUrl("
                            + JSONObject.quote(url) + ");",
                    null
            );
        } catch (RuntimeException ignored) {
            // The page may be between renderer processes; a later launch can retry.
            pendingLaunchUrl = url;
        }
    }

    private static String extractSafeLaunchUrl(Intent intent) {
        if (intent == null) {
            return null;
        }
        String candidate = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) {
            Uri data = intent.getData();
            candidate = data == null ? null : data.toString();
        } else if (Intent.ACTION_SEND.equals(intent.getAction())
                && "text/plain".equalsIgnoreCase(intent.getType())) {
            String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (sharedText != null && sharedText.length() <= MAX_LAUNCH_TEXT_LENGTH) {
                Matcher matcher = HTTPS_URL_PATTERN.matcher(sharedText);
                if (matcher.find()) {
                    candidate = trimUrlPunctuation(matcher.group());
                }
            }
        }
        if (candidate == null || candidate.length() > MAX_LAUNCH_TEXT_LENGTH) {
            return null;
        }
        return isSafePublicHttps(candidate) ? candidate : null;
    }

    private static String trimUrlPunctuation(String value) {
        String result = value == null ? "" : value;
        while (!result.isEmpty() && ".,;:!?)]}".indexOf(result.charAt(result.length() - 1)) >= 0) {
            result = result.substring(0, result.length() - 1);
        }
        return result;
    }

    private static boolean isSafePublicHttps(String rawUrl) {
        try {
            Uri uri = Uri.parse(rawUrl.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme())
                    || TextUtils.isEmpty(uri.getHost())
                    || uri.getUserInfo() != null) {
                return false;
            }
            String host = uri.getHost().toLowerCase(Locale.US);
            if (host.equals("localhost") || host.endsWith(".local") || host.contains(":")) {
                return false;
            }
            if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")
                    || host.startsWith("169.254.") || host.matches("172\\.(1[6-9]|2[0-9]|3[0-1])\\..*")) {
                return false;
            }
            return !"0.0.0.0".equals(host);
        } catch (RuntimeException exception) {
            return false;
        }
    }

    private void handleWebViewBack() {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        if (webView != null && pageLoaded) {
            try {
                webView.evaluateJavascript("Boolean(window.resourceRadar && window.resourceRadar.__handleBack());", handled -> {
                    if (!isFinishing() && !isDestroyed() && !"true".equals(handled)) finish();
                });
                return;
            } catch (RuntimeException ignored) {
                // No local navigation is possible after the renderer disappears.
            }
        }
        finish();
    }

    @Override
    protected void onDestroy() {
        UpdateManager.get(this).detach(this);
        if (bridge != null) {
            bridge.close();
        }
        if (nativeService != null) {
            try {
                nativeService.close();
            } catch (RuntimeException ignored) {
                // WebView teardown must still complete if a backend resource was
                // already reclaimed by the process or foreground service.
            }
        }
        if (webView != null) {
            webView.removeJavascriptInterface(ResourceRadarBridge.JAVASCRIPT_INTERFACE_NAME);
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private final class LocalOnlyWebViewClient extends WebViewClient {
        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (isAllowedAssetUrl(url)) {
                pageLoaded = true;
                dispatchLaunchUrlIfReady();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return request == null || !isAllowedAssetUrl(request.getUrl() == null ? null : request.getUrl().toString());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return !isAllowedAssetUrl(url);
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            String url = request == null || request.getUrl() == null ? null : request.getUrl().toString();
            return loadLocalAsset(url);
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
            return loadLocalAsset(url);
        }
    }

    private static boolean isAllowedAssetUrl(String rawUrl) {
        if (rawUrl == null || !rawUrl.startsWith(LOCAL_ASSET_ORIGIN)) {
            return false;
        }
        Uri uri = Uri.parse(rawUrl);
        String path = uri.getPath();
        if (path == null || !path.startsWith("/assets/") || path.contains("\\") || uri.getUserInfo() != null) {
            return false;
        }
        String[] segments = path.substring("/assets/".length()).split("/");
        for (String segment : segments) {
            if (segment.isEmpty() || "..".equals(segment) || ".".equals(segment)) {
                return false;
            }
        }
        return true;
    }

    private WebResourceResponse loadLocalAsset(String rawUrl) {
        if (!isAllowedAssetUrl(rawUrl)) {
            return blockedResponse();
        }
        Uri uri = Uri.parse(rawUrl);
        String path = uri.getPath();
        if (path == null || !path.startsWith("/assets/")) {
            return blockedResponse();
        }
        String assetPath = path.substring("/assets/".length());
        try {
            AssetManager assets = getAssets();
            InputStream input = assets.open(assetPath, AssetManager.ACCESS_STREAMING);
            return new WebResourceResponse(assetMimeType(assetPath), StandardCharsets.UTF_8.name(), input);
        } catch (IOException | RuntimeException exception) {
            return blockedResponse();
        }
    }

    private static String assetMimeType(String assetPath) {
        if (assetPath == null) return "application/octet-stream";
        String lower = assetPath.toLowerCase(Locale.US);
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".js")) return "text/javascript";
        if (lower.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    private static WebResourceResponse blockedResponse() {
        return new WebResourceResponse(
                "text/plain",
                StandardCharsets.UTF_8.name(),
                new ByteArrayInputStream(new byte[0])
        );
    }
}
