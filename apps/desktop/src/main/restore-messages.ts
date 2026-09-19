// D-046: paired native-dialog copy; renderer copy lives in the UI locale catalog.
const ZH = {
  chooseTitle: "选择 Guild 2.1 校验备份", title: "恢复本地备份",
  question: "用所选备份替换 Guild 的本地数据？",
  detail: "任务、个人资料、语言、运行设置和附件将恢复到备份时的状态。项目文件与本机外观偏好保持不变。Guild 会保留旧数据，并在验证后重新启动。",
  cancel: "取消", restore: "验证并恢复", failed: "备份恢复未完成",
  closeFailed: "Guild 未能安全关闭存储或运行进程，恢复已取消，本地数据尚未替换。请重新打开 Guild 后重试。",
  exchangeFailed: "备份替换未完成。Guild 将重新启动并检查回滚记录；请确认原有任务后再重试。",
};
const EN: { readonly [K in keyof typeof ZH]: string } = {
  chooseTitle: "Choose a verified Guild 2.1 backup", title: "Restore local backup",
  question: "Replace Guild local data with this backup?",
  detail: "Tasks, profile, language, runtime settings, and attachments will return to the backup state. Project files and local appearance preferences stay unchanged. Guild keeps the previous data and restarts after validation.",
  cancel: "Cancel", restore: "Validate and restore", failed: "Backup restore did not finish",
  closeFailed: "Guild could not safely close storage or a runtime process. Restore was cancelled and local data was not replaced. Reopen Guild and try again.",
  exchangeFailed: "The backup exchange did not finish. Guild will restart and check its rollback journal. Verify your original tasks before trying again.",
};
export const restoreMessages = (chinese: boolean) => chinese ? ZH : EN;
