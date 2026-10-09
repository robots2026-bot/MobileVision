package com.mobilevision.android;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;

// Native-only helper runs in the test APK's separate UID, outside instrumentation.
public class ShareSenderActivity extends Activity {
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String batch = getIntent().getStringExtra("batch");
        if (batch == null || !batch.matches("[a-z0-9-]{1,70}")) { finish(); return; }
        int count = Math.max(1, Math.min(2, getIntent().getIntExtra("count", 1)));
        File folder = new File(getCacheDir(), "shared-fixtures"); folder.mkdirs();
        ArrayList<Uri> uris = new ArrayList<>();
        try {
            for (int index = 1; index <= count; index++) {
                File file = new File(folder, batch + "-" + index + ".txt");
                Files.write(file.toPath(), ("MobileVision share fixture: " + batch + "/" + index + "\n中文附件\n").getBytes(StandardCharsets.UTF_8));
                uris.add(Uri.parse("content://com.mobilevision.android.test.shared-files/" + file.getName()));
            }
            Intent share = new Intent(count == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE).setType("text/plain").setPackage("com.mobilevision.android").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ClipData clip = ClipData.newRawUri("synthetic files", uris.get(0));
            for (int index = 1; index < uris.size(); index++) clip.addItem(new ClipData.Item(uris.get(index)));
            share.setClipData(clip);
            if (count == 1) share.putExtra(Intent.EXTRA_STREAM, uris.get(0)); else share.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            boolean chooser = getIntent().getBooleanExtra("chooser", false);
            if (chooser) share.setPackage(null);
            startActivity(chooser ? Intent.createChooser(share, "分享测试文件") : share);
        } catch (Exception error) { throw new RuntimeException(error); }
        finish();
    }
}
