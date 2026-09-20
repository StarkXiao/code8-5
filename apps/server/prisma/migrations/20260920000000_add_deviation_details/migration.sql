-- 复做失败时按步骤记录的结构化偏差（DeviationEntry[] 的 JSON 文本）。
-- 旧记录该列为 NULL，偏差仍可从 deviations 自由文本读取。
ALTER TABLE "VerificationRun" ADD COLUMN "deviationDetails" TEXT;
