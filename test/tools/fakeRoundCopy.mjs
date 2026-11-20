/* eslint-disable no-template-curly-in-string -- 下列字串為「被插入複本之原始碼片段」(含 ${…} 字樣), 不是本檔之樣板字串 */
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'


//測試用: 產一份 tools/fakeRound.mjs 之複本, 可指定「第 1 輪之節點依何種次序派工」與(故障注入用之)文字改寫; src 之原檔不含控制派工次序之手段, 也不為測試新增選項
//  為何: 實跑時節點之派工次序由派工前之閘(資源閘: 全機負載高時放行次序不定; 未設資源上限者為計畫次序)決定, 於合成專案上無法固定 ⇒
//    測試以此複本把次序釘死(模擬「資源閘依另一個次序放行」), 驗證 fakeRound 之各項核對與派工次序無關
//  作法(對 srcFile 之原文做文字改寫, 不改原檔; 每處錨點須於原文恰出現 1 次, 否則拋錯):
//    ① 相對匯入('../cfg.mjs' 之類)改為指向 srcFile 所在處之檔案網址(複本放在別處〔測試之暫存夾〕仍可匯入套件之 src)
//    ② order 有給者: 於「let dispatch = async (role, { prompt, logFile }) => {」之前插入派工之排序包裝: 第 1 輪之節點(依 plan.json 之計畫次序; 入樹與做夢範本之次序亦同)
//       依 order 逐一派工(前一個派工結束才放行下一個; 未列於 order 者接在其後、依計畫次序); 其後之派工(重做、第 2 輪)不經排序
//    ③ edits 有給者: 逐一以字串替換(故障注入: 把複本改成「某項功能壞掉」之樣子, 驗證核對仍會失敗)
//  opt:
//    srcFile, outFile   原檔與複本之路徑(複本須在 fakeRound 之 tmp/fake 之外 —— fakeRound 啟動時會清空 tmp/fake)
//    order              (選配)1 起算之計畫序號之陣列(互異之正整數; 例 [2] = 計畫第 2 個最先派工、其餘依計畫次序; [3, 2, 1] = 完全反向); 序號超出本輪之節點數 ⇒ 第 1 個派工時拋錯
//    orderLog           order 有給者必給: 派工紀錄檔(絕對路徑; 追加寫入): 第 1 列「plan <計畫次序之節點 id…>」, 其後每派工一個節點寫一列「dispatch <節點 id>」
//    edits              (選配)[[找, 換]…]
const ANCHOR = 'let dispatch = async (role, { prompt, logFile }) => {'

export let makeFakeRoundCopy = ({ srcFile, outFile, order = null, orderLog = null, edits = [] }) => {
    if (order !== null && (!Array.isArray(order) || !order.length || order.some((x) => !Number.isInteger(x) || x < 1) || new Set(order).size !== order.length)) {
        throw new Error('invalid order: must be an array of distinct positive integers')
    }
    if (order !== null && typeof orderLog !== 'string') {
        throw new Error('invalid orderLog: must be a string')
    }
    let src = fs.readFileSync(srcFile, 'utf8')
    let dir = path.dirname(path.resolve(srcFile))
    src = src.replace(/(\bfrom\s+)'(\.{1,2}\/[^']+)'/g, (m, head, rel) => `${head}'${pathToFileURL(path.resolve(dir, rel)).href}'`)
    let once = (find) => {
        let n = src.split(find).length - 1
        if (n !== 1) {
            throw new Error(`anchor must appear exactly once in ${srcFile} (found ${n}): ${find.slice(0, 60)}`)
        }
    }
    //原檔可能為 CRLF: 錨點與改寫以 LF 書寫, 先把複本轉為 LF
    src = src.replace(/\r\n/g, '\n')
    if (order !== null) {
        once(ANCHOR)
        let wrap = [
            `let __ord = { want: ${JSON.stringify(order)}, log: ${JSON.stringify(path.resolve(orderLog))}, seq: null, turn: 0, waiting: [], done: new Set() }`,
            'let __ordPump = () => {',
            '    let i = __ord.turn < __ord.seq.length ? __ord.waiting.findIndex((w) => w.id === __ord.seq[__ord.turn]) : -1',
            '    if (i >= 0) {',
            '        let [w] = __ord.waiting.splice(i, 1)',
            '        w.resolve()',
            '    }',
            '}',
            'let dispatch = async (role, args) => {',
            '    if (role !== \'node\') {',
            '        return dispatch0(role, args)',
            '    }',
            '    let id = path.basename(path.resolve(FD_ROOT, /請閱讀 (\\S+)\\/brief\\.md/.exec(args.prompt)[1]))',
            '    if (__ord.seq === null) {',
            '        //第 1 個派工到達時, 本輪之計畫(plan.json)已寫成; 計畫次序 = 入樹次序 = 做夢範本之次序',
            '        let ids = JSON.parse(fs.readFileSync(path.join(Pj.rsi.paths.fdRound(round), \'plan.json\'), \'utf8\')).items.map((x) => x.id)',
            '        if (__ord.want.some((k) => k > ids.length)) {',
            '            throw new Error(`order out of range: ${__ord.want.join(\',\')} (nodes ${ids.length})`)',
            '        }',
            '        let first = __ord.want.map((k) => ids[k - 1])',
            '        __ord.seq = [...first, ...ids.filter((x) => !first.includes(x))]',
            '        fs.appendFileSync(__ord.log, `plan ${ids.join(\' \')}\\n`)',
            '    }',
            '    if (__ord.done.has(id) || !__ord.seq.includes(id)) {',
            '        return dispatch0(role, args)',
            '    }',
            '    await new Promise((resolve, reject) => {',
            '        let tm = setTimeout(() => reject(new Error(`order wait timeout: ${id}`)), 120000)',
            '        __ord.waiting.push({ id, resolve: () => { clearTimeout(tm); resolve() } })',
            '        __ordPump()',
            '    })',
            '    fs.appendFileSync(__ord.log, `dispatch ${id}\\n`)',
            '    try {',
            '        return await dispatch0(role, args)',
            '    }',
            '    finally {',
            '        __ord.done.add(id)',
            '        __ord.turn++',
            '        __ordPump()',
            '    }',
            '}',
            'let dispatch0 = async (role, { prompt, logFile }) => {',
        ].join('\n')
        src = src.replace(ANCHOR, () => wrap)
    }
    for (let [find, rep] of edits) {
        once(find)
        src = src.replace(find, () => rep)
    }
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
    fs.writeFileSync(outFile, src, 'utf8')
    return outFile
}
