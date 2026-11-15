import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'


//把本套件接到一個專案根: 建立或更新進入檔與參考檔(安裝或升版後執行一次)
//  node node_modules/w-trade-adaptivess/src/tools/initProject.mjs [--root <專案根>] [--dry] [--force]
//  專案根 = --root 所給者; 未給時取環境變數 ARSI_ROOT, 再無則為行程之工作目錄
//  進入檔(內容由套件決定, 專案不手改; 設定 ARSI_ROOT 後載入套件之程式):
//    g_eval.mjs、g_rsi.mjs、g_build.mjs、g_launch.mjs、g_toolbox.mjs、g_backtest.mjs、tools/<名>.mjs(本套件各工具)
//    已存在而不是本工具所產生者(首行無標記)**不覆寫並列出** —— 確認其內容可捨棄後加 --force 才覆寫(由舊配置之專案改用本套件時用)
//  每次皆覆寫(套件之參考檔): examples/pick_example.mjs
//  只在不存在時才寫(之後由專案自行維護): settings.json(參考設定)、arms/base.json(臂目錄之基底)、docs/pick-contract.md(挑選模組之合約; agent 所讀)
//    合約含專案自己之數值(各期間、求解窗、標的)⇒ 由專案維護; 已存在而與套件之參考版不同時不覆寫, 另把參考版寫為 docs/pick-contract.pkg.md 並列出 ——
//    升版後請比對兩者, 把參考版新增或更動之條文併入專案之合約(合併後可刪 .pkg.md)
//  不動: 狀態根(rsi/)、資料(data/)、專案自有之文件與其他檔
//  --dry: 只列出將寫入之檔, 不寫
//  回傳(initProject 函數): { root, written[], kept[], skipped[], differs[] }
let FD_PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let PKG = 'w-trade-adaptivess'
/**
 * 進入檔首行標記字串; 首行為此標記者視為本工具所產生, 可被覆寫
 *
 * @type {String}
 */
let MARK = '//由 w-trade-adaptivess 之 initProject 產生(升版後重新執行即更新; 請勿手改)'
/**
 * 會為專案產生 g_<名>.mjs 進入檔之本套件命令列名稱清單
 *
 * @type {Array}
 */
let CLIS = ['eval', 'rsi', 'build', 'launch', 'toolbox', 'backtest']
//TOOLS_SKIP, 不為其產生專案進入檔之工具: 本工具自身
let TOOLS_SKIP = new Set(['initProject'])

//shimOf, 進入檔之內容: 把專案根(進入檔往上 up 層)告知套件後載入 spec
/**
 * 產生專案進入檔之內容: 先把專案根(進入檔往上 up 層)設入環境變數 ARSI_ROOT, 再動態載入 spec
 *
 * @param {String} spec 輸入要載入之模組指定字串, 如 w-trade-adaptivess/src/cli/eval.mjs
 * @param {Integer} up 輸入進入檔往上幾層為專案根(0 為進入檔所在資料夾)
 * @returns {String} 回傳進入檔文字內容(首行為 MARK)
 * @example
 * let text = shimOf('w-trade-adaptivess/src/cli/eval.mjs', 0)
 */
let shimOf = (spec, up) => [
    MARK,
    'import path from \'path\'',
    'import { fileURLToPath } from \'url\'',
    '',
    `process.env.ARSI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url))${up > 0 ? `, ${Array.from({ length: up }, () => '\'..\'').join(', ')}` : ''})`,
    `await import('${spec}')`,
    '',
].join('\n')

/**
 * 把本套件接到一個專案根: 建立或更新進入檔與參考檔(安裝或升版後執行一次)
 * 各檔之覆寫規則見檔頭說明; 專案根不可為套件夾本身, 否則拋錯
 *
 * @param {Object} [opt={}] 輸入設定物件,預設{}
 * @param {String} [opt.root] 輸入專案根路徑,未給時取環境變數 ARSI_ROOT,再無則取行程工作目錄
 * @param {Boolean} [opt.dry=false] 輸入是否只列出將寫入之檔而不實際寫入,預設false
 * @param {Boolean} [opt.force=false] 輸入是否覆寫已存在而非本工具所產生之進入檔,預設false
 * @returns {Object} 回傳 { root(專案根絕對路徑), written(已寫入或將寫入之相對路徑陣列), kept(未變之相對路徑陣列), skipped(因非本工具所產生而未覆寫者), differs(合約與參考版不同者) }
 * @example
 * let r = initProject({ root: './myproj', dry: true })
 */
let initProject = ({ root, dry = false, force = false } = {}) => {
    let fdRoot = path.resolve(root || process.env.ARSI_ROOT || process.cwd())
    if (path.resolve(fdRoot) === FD_PKG) {
        throw new Error('專案根不可為套件夾本身(套件夾已自帶進入檔與參考檔)')
    }
    let written = []
    let kept = []
    let skipped = []
    let put = (rel, text, { onlyIfAbsent = false, needMark = false } = {}) => {
        let fp = path.join(fdRoot, rel)
        if (fs.existsSync(fp)) {
            if (onlyIfAbsent) {
                kept.push(rel)
                return
            }
            let cur = fs.readFileSync(fp, 'utf8')
            if (needMark && !cur.startsWith(MARK)) {
                skipped.push(rel)
                return
            }
            if (cur === text) {
                kept.push(rel)
                return
            }
        }
        if (!dry) {
            fs.mkdirSync(path.dirname(fp), { recursive: true })
            fs.writeFileSync(fp, text, 'utf8')
        }
        written.push(rel)
    }
    for (let c of CLIS) {
        put(`g_${c}.mjs`, shimOf(`${PKG}/src/cli/${c}.mjs`, 0), { needMark: !force })
    }
    let tools = fs.readdirSync(path.join(FD_PKG, 'src', 'tools')).filter((f) => /\.mjs$/.test(f)).map((f) => f.replace(/\.mjs$/, '')).filter((t) => !TOOLS_SKIP.has(t)).sort()
    for (let t of tools) {
        put(`tools/${t}.mjs`, shimOf(`${PKG}/src/tools/${t}.mjs`, 1), { needMark: !force })
    }
    let copy = (from, to, opt) => put(to, fs.readFileSync(path.join(FD_PKG, from), 'utf8'), opt)
    //合約: 專案維護; 不存在才寫, 與參考版不同者另寫參考版供比對
    let differs = []
    {
        let ref = fs.readFileSync(path.join(FD_PKG, 'contract', 'pick-contract.md'), 'utf8')
        let fpC = path.join(fdRoot, 'docs', 'pick-contract.md')
        let fpSide = path.join(fdRoot, 'docs', 'pick-contract.pkg.md')
        if (!fs.existsSync(fpC)) {
            put('docs/pick-contract.md', ref)
        }
        else if (fs.readFileSync(fpC, 'utf8') === ref) {
            kept.push('docs/pick-contract.md')
            if (fs.existsSync(fpSide) && !dry) {
                fs.rmSync(fpSide, { force: true })
            }
        }
        else {
            differs.push('docs/pick-contract.md')
            put('docs/pick-contract.pkg.md', ref)
        }
    }
    copy('examples/pick_example.mjs', 'examples/pick_example.mjs')
    copy('arms/base.json', 'arms/base.json', { onlyIfAbsent: true })
    copy('settings.json', 'settings.json', { onlyIfAbsent: true })
    return { root: fdRoot, written, kept, skipped, differs }
}

//直接執行時(非被匯入): 依命令列執行並列出結果
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    let i = process.argv.indexOf('--root')
    let r
    try {
        r = initProject({ root: i > 0 ? process.argv[i + 1] : null, dry: process.argv.includes('--dry'), force: process.argv.includes('--force') })
    }
    catch (err) {
        console.log(`未執行: ${String((err && err.message) || err)}`)
        process.exit(2)
    }
    console.log(`專案根 ${r.root}:${process.argv.includes('--dry') ? '將寫入' : '已寫入'} ${r.written.length} 檔${r.written.length ? `(${r.written.join('、')})` : ''};未變 ${r.kept.length} 檔${r.skipped.length ? `;**未覆寫 ${r.skipped.length} 檔**(同名而非本工具所產生;確認可捨棄後加 --force: ${r.skipped.join('、')})` : ''}${r.differs.length ? `;**合約與套件之參考版不同**(未覆寫;參考版已寫為 docs/pick-contract.pkg.md,請比對後併入)` : ''}`)
}


export { initProject, shimOf, MARK, CLIS }
export default initProject
