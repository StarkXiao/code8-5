import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '..', '..');

/** node:sqlite 需要 Node ≥ 22.5；旧环境（如 CI 自带的 Node 20）回退到 prisma migrate deploy */
function nodeSqliteAvailable(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 5);
}

/**
 * 测试前准备一个全新的 SQLite 库。
 * 优先复用与生产完全相同的迁移脚本，确保"测试跑得通"等价于"迁移没问题"；
 * 在不支持 node:sqlite 的旧 Node 上回退到 `prisma migrate deploy`（同一套 SQL）。
 */
export default function setup() {
  const dataDir = path.join(repoRoot, 'data');
  for (const target of ['test.db', 'test.db-wal', 'test.db-shm', 'test-audio']) {
    fs.rmSync(path.join(dataDir, target), { recursive: true, force: true });
  }

  // Prisma 把相对 SQLite 路径解析到 schema.prisma 所在目录，
  // 而应用运行时解析到仓库根目录 —— 回退路径必须传绝对路径，否则两边用的不是同一个库。
  const migrateEnv = {
    ...process.env,
    DATABASE_URL: `file:${path.join(dataDir, 'test.db')}`,
  };

  const result = nodeSqliteAvailable()
    ? spawnSync('node', [path.join(serverRoot, 'scripts', 'migrate.mjs')], {
        cwd: serverRoot,
        env: migrateEnv,
        encoding: 'utf8',
      })
    : spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
        cwd: serverRoot,
        env: migrateEnv,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });

  if (result.status !== 0) {
    throw new Error(`测试数据库迁移失败：\n${result.stdout}\n${result.stderr}`);
  }
}
