import path from 'path'


//distBuild, 以 toolg/gDistRollup.mjs 同一組選項把指定套件根之 ./src 打包為 UMD 單檔(排程第 477 項 ② 之驗證用; 供 test/unit-pkgRoot.test.mjs 與於發布包解開之目錄驗證)
//  用法: node test/tools/distBuild.mjs <套件根> <輸出夾>   輸出夾須在套件根之下(rollupFiles 以相對於套件根之路徑寫出; 不動套件之 ./dist)
//  rollupFiles(w-package-tools; devDependency)由本套件之上層 node_modules 解析(發布包解開於 ./tmp/ 者亦然); 解析不到 ⇒ 離開碼 3(測試據以略過)
let [root0, out0] = process.argv.slice(2)
if (!root0 || !out0) {
    console.log('用法: node test/tools/distBuild.mjs <套件根> <輸出夾>')
    process.exit(2)
}
let root = path.resolve(root0)
let out = path.resolve(out0)
let rel = path.relative(root, out).replace(/\\/g, '/')
if (!rel || rel.startsWith('..')) {
    console.log('輸出夾須在套件根之下')
    process.exit(2)
}
let rollupFiles
try {
    rollupFiles = (await import('w-package-tools/src/rollupFiles.mjs')).default
}
catch (err) {
    console.log(`無法載入 w-package-tools: ${String((err && err.message) || err).slice(0, 200)}`)
    process.exit(3)
}
process.chdir(root)
rollupFiles({
    fns: 'WTradeAdaptivess.mjs',
    fdSrc: './src',
    fdTar: `./${rel}`,
    nameDistType: 'kebabCase',
    runin: 'nodejs',
    globals: { 'path': 'path', 'fs': 'fs', 'os': 'os', 'url': 'url', 'crypto': 'crypto', 'child_process': 'child_process', 'module': 'module' },
    external: ['path', 'fs', 'os', 'url', 'crypto', 'child_process', 'module', /^w-recursi\//, /^w-trade-backtest\//],
})
//rollupFiles 為非同步(寫檔於其後完成): 本行程於其完成後自然結束(不 process.exit 以免截斷寫檔); 呼叫端(測試)於子行程結束後檢查輸出檔
