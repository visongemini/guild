import assert from "node:assert/strict";
import test from "node:test";
import { LOCALES, messagesFor } from "./locales.js";

test("Chinese and English catalogs expose the same keys", () => {
  assert.deepEqual(Object.keys(LOCALES["zh-CN"]).sort(), Object.keys(LOCALES["en-US"]).sort());
});

test("settings and profile strings are present in both catalogs", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const messages = messagesFor(locale);
    assert.equal(messages.settingsGeneral.length > 0, true);
    assert.equal(messages.settingsGrok.length > 0, true);
    assert.equal(messages.settingsPrivacy.length > 0, true);
    assert.equal(messages.settingsAbout.length > 0, true);
    assert.equal(messages.editProfile.length > 0, true);
    assert.equal(messages.localProfile.length > 0, true);
    assert.equal(messages.restoreLastTask.length > 0, true);
    assert.equal(messages.newTaskWorkspaceAsk.length > 0, true);
    assert.equal(messages.privacyBrowserSyncOff.length > 0, true);
    assert.equal(messages.openDataDirectory.length > 0, true);
    assert.equal(messages.workspaceFolderMissing.length > 0, true);
    assert.equal(messages.messageTooLong.length > 0, true);
    assert.equal(messages.closeDialog.length > 0, true);
    assert.equal(messages.commandWaiting.length > 0, true);
    assert.equal(messages.commandCompleted.length > 0, true);
    assert.equal(messages.toolKindLabel("search").length > 0, true);
  }
});
