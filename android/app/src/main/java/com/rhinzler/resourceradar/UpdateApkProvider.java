package com.rhinzler.resourceradar;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/** Read-only provider exposing only the app's verified private update APK directory. */
public final class UpdateApkProvider extends ContentProvider {
    static Uri uriForFile(android.content.Context context, File file) throws FileNotFoundException {
        if (context == null || file == null) throw new FileNotFoundException("The update APK is unavailable.");
        File root;
        File target;
        try {
            root = new File(context.getFilesDir(), "update-apk").getCanonicalFile();
            target = file.getCanonicalFile();
        } catch (java.io.IOException exception) {
            throw new FileNotFoundException("The update APK is unavailable.");
        }
        if (!root.equals(target.getParentFile()) || !target.isFile()
                || !target.getName().matches("[a-f0-9-]{36}\\.apk")
                || !UpdateManager.get(context).canExposeVerifiedApk(target)) {
            throw new FileNotFoundException("The update APK is unavailable.");
        }
        return new Uri.Builder().scheme("content")
                .authority(context.getPackageName() + ".updates")
                .appendPath(target.getName()).build();
    }

    @Override
    public boolean onCreate() { return true; }

    @Override
    public String getType(Uri uri) { return "application/vnd.android.package-archive"; }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) {
            throw new FileNotFoundException("Only read-only APK access is supported.");
        }
        return ParcelFileDescriptor.open(fileForUri(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs,
                        String sortOrder) {
        String[] columns = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        MatrixCursor cursor = new MatrixCursor(columns);
        try {
            File file = fileForUri(uri);
            MatrixCursor.RowBuilder row = cursor.newRow();
            for (String column : columns) {
                if (OpenableColumns.DISPLAY_NAME.equals(column)) row.add(file.getName());
                else if (OpenableColumns.SIZE.equals(column)) row.add(file.length());
                else row.add(null);
            }
        } catch (FileNotFoundException ignored) {
            // An unavailable verified file is an empty provider result.
        }
        return cursor;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }

    @Override
    public Uri insert(Uri uri, ContentValues values) { return null; }

    private File fileForUri(Uri uri) throws FileNotFoundException {
        if (uri == null || !"content".equals(uri.getScheme())
                || !(getContext().getPackageName() + ".updates").equals(uri.getAuthority())
                || uri.getQuery() != null || uri.getFragment() != null
                || uri.getPathSegments().size() != 1
                || !uri.getPathSegments().get(0).matches("[a-f0-9-]{36}\\.apk")) {
            throw new FileNotFoundException("The update APK is unavailable.");
        }
        File root = new File(getContext().getFilesDir(), "update-apk");
        File file = new File(root, uri.getPathSegments().get(0)).getAbsoluteFile();
        try {
            File canonicalRoot = root.getCanonicalFile();
            File canonicalFile = file.getCanonicalFile();
            if (!canonicalRoot.equals(canonicalFile.getParentFile())
                    || !canonicalFile.isFile()
                    || !UpdateManager.get(getContext()).canExposeVerifiedApk(canonicalFile)) {
                throw new FileNotFoundException("The update APK is unavailable.");
            }
            return canonicalFile;
        } catch (java.io.IOException exception) {
            throw new FileNotFoundException("The update APK is unavailable.");
        }
    }
}
