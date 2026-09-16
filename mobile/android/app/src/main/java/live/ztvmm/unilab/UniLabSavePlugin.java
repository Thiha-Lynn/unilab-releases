package live.ztvmm.unilab;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.io.OutputStream;
import java.util.UUID;

/** Writes only to a document the user explicitly creates in Android's system picker. */
@CapacitorPlugin(name = "UniLabSave")
public class UniLabSavePlugin extends Plugin {
    private String exportId;
    private Uri document;
    private OutputStream output;
    private long expected, written;
    private boolean picking;

    @PluginMethod public synchronized void begin(PluginCall call) {
        if (output != null || picking) { call.reject("Finish the current save first."); return; }
        Long size = call.getLong("size");
        if (size == null || size < 0 || size > 2L * 1024 * 1024 * 1024) { call.reject("Invalid export size."); return; }
        String name = call.getString("name", "UniLab-result").replaceAll("[\\\\/\\p{Cntrl}]", "_");
        if (name.length() > 180) name = name.substring(0, 180);
        String mime = call.getString("mime", "application/octet-stream");
        if (!mime.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+")) mime = "application/octet-stream";
        expected = size;
        picking = true;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        try { startActivityForResult(call, intent, "chosenDocument"); }
        catch (Exception e) { picking = false; call.reject("A system file picker is unavailable."); }
    }
    @ActivityCallback private synchronized void chosenDocument(PluginCall call, ActivityResult result) {
        picking = false;
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("Save cancelled.", "USER_CANCELLED"); return;
        }
        document = result.getData().getData();
        try {
            output = getContext().getContentResolver().openOutputStream(document, "w");
            if (output == null) throw new Exception();
            written = 0;
            exportId = UUID.randomUUID().toString();
            JSObject reply = new JSObject(); reply.put("id", exportId); call.resolve(reply);
        } catch (Exception e) { discard(); call.reject("Could not open the chosen location."); }
    }
    private boolean active(PluginCall call) {
        return output != null && exportId != null && exportId.equals(call.getString("id"));
    }
    @PluginMethod public synchronized void append(PluginCall call) {
        if (!active(call)) { call.reject("This save is no longer active."); return; }
        String data = call.getString("data", "");
        try {
            if (data.length() > 262144) throw new Exception();
            byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
            if (bytes.length > 196608 || written + bytes.length > expected) throw new Exception();
            output.write(bytes); written += bytes.length; call.resolve();
        } catch (Exception e) { discard(); call.reject("Save failed. Check storage space and try again."); }
    }
    @PluginMethod public synchronized void finish(PluginCall call) {
        if (!active(call)) { call.reject("This save is no longer active."); return; }
        try {
            if (written != expected) throw new Exception();
            output.flush(); output.close(); output = null; document = null; exportId = null;
            call.resolve();
        } catch (Exception e) { discard(); call.reject("The complete file could not be saved."); }
    }
    @PluginMethod public synchronized void cancel(PluginCall call) {
        if (active(call)) discard();
        call.resolve();
    }
    private void discard() {
        try { if (output != null) output.close(); } catch (Exception ignored) {}
        // ACTION_CREATE_DOCUMENT creates a new file; remove our incomplete result.
        try { if (document != null) DocumentsContract.deleteDocument(getContext().getContentResolver(), document); } catch (Exception ignored) {}
        output = null; document = null; exportId = null; written = 0;
    }
    @Override protected synchronized void handleOnDestroy() { discard(); }
}
