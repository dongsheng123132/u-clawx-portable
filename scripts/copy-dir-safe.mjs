import fs from 'node:fs';
import path from 'node:path';

/**
 * Node 22.20 的 fs.cpSync 目录递归模式在源路径含非 ASCII 字符（如中文「版本」）时
 * 进程级 abort（exit 3221226505 / c0000409，无异常抛出）。本仓库目录名带
 * 「--4.0版本」必然踩中。此模块提供语义对齐的手动递归替代。
 */
export function copyDirSafe(src, dest, dereference = true, filter = null) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const sp = path.join(src, entry);
    const dp = path.join(dest, entry);
    if (filter && !filter(sp, dp)) continue;
    let st;
    try { st = dereference ? fs.statSync(sp) : fs.lstatSync(sp); } catch { continue; }
    if (dereference) {
      // statSync 已跟随符号链接；断链在 statSync 处抛错，跳过
      if (st.isDirectory()) copyDirSafe(sp, dp, dereference, filter);
      else if (st.isFile()) {
        try { fs.copyFileSync(fs.realpathSync(sp), dp); } catch { /* skip */ }
      }
    } else {
      if (st.isDirectory()) copyDirSafe(sp, dp, dereference, filter);
      else if (st.isFile()) fs.copyFileSync(sp, dp);
    }
  }
}
