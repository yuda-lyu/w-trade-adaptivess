import path from 'path'
import { spawnSync } from 'child_process'
import { scanPick, scanSnippet, stripComments } from '../eval/pickLoader.mjs'
import { contentHits } from './verify.mjs'
import { FD_ROOT } from '../cfg.mjs'


//共用工具區之專案規則(逐檔之內容檢查、索引之格式與初始內容); 迴圈之機械檢查(src/domain/domain.mjs)與自檢入口(g_toolbox.mjs)共用同一份
//  節點與做夢共用同一區(不分彼此): 節點只讀、只用; 做夢統籌擴建
//  snippets/  可貼入挑選模組之純函數片段(挑選模組不得 import ⇒ 節點複製使用; 須過與挑選模組相同之字樣限制)
//  templates/ 完整之挑選模組樣板(須過挑選模組之靜態檢查)
//  diag/      診斷腳本: 只讀評估結果檔與 .evals.log; 只可匯入 node 內建模組(不得匯入 lib/、不得起子行程 ⇒ 無從自行計算績效或接觸帳本)
//  metrics/   **擴充診斷**(規則 R-EV-21): 每次完整評估由評估器自動載入、結果附於評估輸出之 metrics.ext.<檔名> 與節點文件
//             每檔 `export default function (api) { … return { text, … } }`; 與挑選模組同一組字樣限制; 只拿得到唯讀之 api(見 docs/pick-contract.md §7)
//             ⇒ 改不了 S、階梯、selHash 與任何既有欄。機械檢查另以範例挑選模組實際試跑一次(逾時或拋錯即不合)
//  各檔另查: 語法(node --check)、禁區字樣(與操作掃描同一組)
//  索引: 須有「## 依情境找工具」一節(一列一個情境:「遇到什麼情況 → 用哪個檔」), 且每個工具檔都出現在該節內 —— agent 不必讀程式碼即知何時用哪個工具
//  makeToolboxRules({ privateRoot }) → { dirs, checkFile({ rel, abs, src }) → [問題字串], checkIndex({ text, files }) → [問題字串], indexSeed }
let TB_DIRS = ['snippets', 'templates', 'diag', 'metrics']
let TB_BUILTIN = /^(node:)?(fs|path|url|os|util|crypto|assert)(\/promises)?$/
let TB_TRIGGER = '## 依情境找工具'
let TB_SEED = [
    '# 共用工具區(索引)',
    '',
    '節點與做夢共用之工具(同一區,不分彼此)。**由做夢 agent 統籌擴建並維護本索引**;節點只讀、只用,不改。',
    '',
    '- `snippets/`:可貼入挑選模組之純函數片段(挑選模組不得 `import`,請**複製**進自己的檔)。',
    '- `templates/`:完整之挑選模組樣板。',
    '- `diag/`:診斷腳本(只讀評估結果檔與 `.evals.log`;用法 `node <腳本> <結果檔…>`)。',
    '- `metrics/`:擴充診斷(每次完整評估由評估器自動算出,列於評估輸出之「擴充診斷」與節點文件;不必自己跑)。',
    '',
    '節點用了哪些,寫入節點文件之 `code.reused`;自己寫了別的節點也可能用到之輔助,寫入 `code.shareable`(做夢會整併)。',
    '',
    TB_TRIGGER,
    '',
    '(一列一個情境:**遇到什麼情況 → 用哪個檔**;每個工具檔都要出現在本節。先看本節,再看下表之用法。)',
    '',
    '## 工具一覽',
    '',
    '| 檔 | 用途 | 用法 | 出處 | 驗證方式 | 加入之輪次 |',
    '|---|---|---|---|---|---|',
    '',
].join('\n')

/**
 * 建立共用工具區之專案規則(逐檔內容檢查、索引格式與初始內容)
 *
 * checkFile 會以子行程執行 node --check,metrics 類另會以範例挑選模組試跑。
 *
 * @param {Object} opt 輸入設定物件
 * @param {String} opt.privateRoot 輸入私有根路徑,供禁區字樣檢查
 * @returns {Object} 回傳 { dirs, checkFile, checkIndex, indexSeed }:dirs 為工具區子夾名;checkFile({ rel, abs, src }) 與 checkIndex({ text, files }) 回傳問題字串陣列;indexSeed 為索引初始文字
 * @example
 * let rules = makeToolboxRules({ privateRoot: './private' })
 * let issues = rules.checkIndex({ text: rules.indexSeed, files: [] })
 */
let makeToolboxRules = ({ privateRoot }) => {
    let checkFile = ({ rel: r, abs, src }) => {
        let e = []
        let top = r.includes('/') ? r.split('/')[0] : ''
        if (!TB_DIRS.includes(top)) {
            e.push(`檔須放在 ${TB_DIRS.map((d) => `${d}/`).join('、')} 之一`)
            return e
        }
        let hits = contentHits(src, privateRoot)
        if (hits.length) {
            e.push(`含禁區字樣: ${hits.join('、')}`)
        }
        if (!/\.mjs$/i.test(r)) {
            return e
        }
        let ck = spawnSync(process.execPath, ['--check', path.resolve(abs)], { windowsHide: true, timeout: 30000, encoding: 'utf8' })
        if (ck.status !== 0) {
            e.push(`語法錯誤: ${String(ck.stderr || ck.error || '').split('\n').filter((l) => /Error/.test(l))[0] || '(node --check 未通過)'}`.slice(0, 200))
        }
        if (top === 'snippets') {
            let s = scanSnippet(src)
            if (s.length) {
                e.push(`片段不合挑選模組之限制: ${s.join('、')}`)
            }
        }
        else if (top === 'templates') {
            let s = scanPick(src)
            if (s.length) {
                e.push(`樣板不是合法之挑選模組: ${s.join('、')}`)
            }
        }
        else if (top === 'metrics') {
            let s = scanSnippet(src)
            if (s.length) {
                e.push(`擴充診斷不合限制(同挑選模組): ${s.join('、')}`)
            }
            if (!/export\s+default\b/.test(stripComments(src))) {
                e.push('擴充診斷須 export default 一個函數')
            }
            if (e.length === 0) {
                //實際試跑(小規模: 相位 0,3、8 抽; 以範例挑選模組為對象): 拋錯、輸出過大或逾時即不合
                let t = spawnSync(process.execPath, [path.join(FD_ROOT, 'g_eval.mjs'), '--pick', path.join(FD_ROOT, 'examples', 'pick_example.mjs'), '--ext-test', path.resolve(abs), '--no-log'], { cwd: FD_ROOT, windowsHide: true, timeout: 300000, encoding: 'utf8', env: { ...process.env, ARSI_HARNESS: '1' } })
                let line = String(t.stdout || '').split('\n').filter((l) => /^EXT_(OK|FAIL)/.test(l)).slice(-1)[0] || ''
                if (t.status !== 0 || !/^EXT_OK/.test(line)) {
                    e.push(`擴充診斷試跑未過: ${line || (t.error ? `逾時或無法執行(${String(t.error.message || t.error).slice(0, 80)})` : `離開碼 ${t.status}`)}`.slice(0, 300))
                }
            }
        }
        else {
            let bad = [...src.matchAll(/(?:^|\n)\s*import\s+(?:[^'"\n]*?\sfrom\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]).filter((spec) => !TB_BUILTIN.test(spec))
            if (bad.length) {
                e.push(`診斷腳本只可匯入 node 內建模組(fs、path 等): ${[...new Set(bad)].join('、')}`)
            }
            if (/\bimport\s*\(|\brequire\s*\(|child_process|\bWorker\b/.test(src)) {
                e.push('診斷腳本不得動態匯入或起子行程 / 執行緒')
            }
        }
        return e
    }
    //checkIndex, 索引須有「依情境找工具」一節, 且每個工具檔都出現在該節內(至下一個同級或更高級之標題為止)
    let checkIndex = ({ text, files }) => {
        let i = text.indexOf(TB_TRIGGER)
        if (i < 0) {
            return [`索引缺「${TB_TRIGGER}」一節(一列一個情境:遇到什麼情況 → 用哪個檔)`]
        }
        let rest = text.slice(i + TB_TRIGGER.length)
        let j = rest.search(/\n#{1,2} /)
        let sec = j < 0 ? rest : rest.slice(0, j)
        let miss = files.filter((f) => !sec.includes(f))
        return miss.length ? [`「依情境找工具」一節未涵蓋 ${miss.length} 個檔: ${miss.slice(0, 6).join('、')}${miss.length > 6 ? ' …' : ''}`] : []
    }
    return { dirs: TB_DIRS, checkFile, checkIndex, indexSeed: TB_SEED }
}


export { makeToolboxRules, TB_DIRS, TB_SEED, TB_TRIGGER }
