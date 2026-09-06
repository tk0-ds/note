/*
 * 移行先の PC でも同じように動くかを確かめるための一括実行。
 *
 *     node tools/vscode-taskchute/test/run.js
 *
 * VS Code は不要。node だけで動く。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const files = ['model.test.js', 'panel.test.js'];
let failed = 0;

console.log('TaskChute for VS Code - 動作確認');
console.log('node ' + process.version + ' / ' + process.platform);

for (const f of files) {
  console.log('\n' + '-'.repeat(60));
  console.log(f);
  console.log('-'.repeat(60));
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed += 1;
}

console.log('\n' + '='.repeat(60));
if (failed === 0) {
  console.log('すべて成功。この PC でそのまま使えます。');
  console.log('次: install.ps1 を実行し、VS Code でこの環境フォルダを開く。');
} else {
  console.log(`${failed} 個のテストファイルで失敗がありました。上の NG 行を確認してください。`);
}
console.log('='.repeat(60));

process.exit(failed === 0 ? 0 : 1);
