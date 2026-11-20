import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { initProject } from '../src/tools/initProject.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'


//tools/fakeRound.mjs 之「量尺之子集與擴充診斷之補算」(規則 R-EV-45 ⑦; 補算之規則 R-REC-27、R-REC-34)
//  合成專案(initProject 產生之參考檔 + 合成帳本; 進入檔 g_eval.mjs 改以檔案網址匯入本套件之評估命令列); 假 agent、不耗模型額度; 每次約數秒
//  「真實診斷」一項(以正式之共用工具區有本工具寫死之診斷名之檔為前提)之處置:
//    略過(不計失敗、離開碼 0): ① 無該名之診斷檔(全新之專案)② 有該檔而第一個節點無其值
//    失敗(離開碼 15; 同 1.0.30): ③ 有該檔而第一個節點之值為錯誤(診斷拋錯、載入失敗)④ 有值而補算失敗
//    通過: ⑤ 有該檔、值正常、補算得同值
//  「自備假診斷」一項(替身評估; 不依賴共用工具區)於①~⑤ 皆執行
let REAL_DIAG = 'nullRecentAct' //fakeRound 寫死之真實診斷名(既有); 替身檔之內容與使用端無關
let SKIP_NO_FILE = `正式之共用工具區無此診斷(無 metrics/${REAL_DIAG}.mjs)`
let SKIP_NO_VALUE = '第一個節點無其值'
let DIAG_OK = 'export default function (api) {\n    return { text: \'替身診斷\', nPhases: api.phases.length }\n}\n'
let DIAG_THROW = 'export default function (api) {\n    throw new Error(\'替身診斷拋錯\')\n}\n'
//載入失敗: 診斷模組不得碰時鐘(合約 §1; 評估器於載入時靜態檢查或執行時拒絕 ⇒ 該診斷之值為錯誤)
let DIAG_CLOCK = 'export default function (api) {\n    return { text: String(Date.now()) }\n}\n'

describe('tools/fakeRound.mjs:擴充診斷之補算 —— 略過不計失敗(限無檔、無值)、值為錯誤與補算失敗仍為離開碼 15、自備假診斷之補算(規則 R-EV-45 ⑦)', function () {
    this.timeout(180000)
    let t
    before(() => {
        t = makeTmp('fakeRound')
    })
    after(() => {
        t.cleanup()
    })

    //mkRoot, 合成專案: initProject 之參考檔 + 合成帳本(60 隻、2400 根 4 小時)+ 改過之設定(期間落在帳本內、關閉資源閘)
    //  opt: { diag(專案之共用工具區放該診斷檔之內容; 未給者不放), failExt(true = 進入檔 g_eval.mjs 遇 --ext-only 即以離開碼 1 結束 ⇒ 補算之評估失敗而節點之初次評估照常),
    //    altToolbox(true = 設定之 records.toolboxDir 指向另一夾 rsi/toolbox_alt), diagAt('default' = 診斷檔放預設之 <rsi.root>/toolbox/metrics〔預設〕/ 'alt' = 放 records.toolboxDir 指向之夾; 須同時給 altToolbox),
    //    nullVal(true = 進入檔把結果檔內該診斷之值改寫為 null), dropVal(true = 進入檔把結果檔內該診斷之值刪除 ⇒ 節點上無其值〔undefined〕) }
    let mkRoot = (name, opt = {}) => {
        let root = path.join(t.dir, name)
        fs.mkdirSync(root, { recursive: true })
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', private: true }), 'utf8')
        initProject({ root })
        //進入檔改以檔案網址匯入本套件之評估命令列(專案內無已安裝之套件); failExt: 補算之評估(帶 --ext-only)失敗之故障注入(測試自己之進入檔, 不動套件)
        let inject = opt.failExt ? 'if (process.argv.includes(\'--ext-only\')) {\n    console.log(\'故障注入: 補算之評估失敗\')\n    process.exit(1)\n}\n' : ''
        //nullVal(true = 把結果檔內該診斷之值改寫為 null ⇒ 節點上之值為 null; 評估器本身只產生物件或 undefined, 此為測試之改寫): 包裝 fs.writeFileSync, 只改寫 --out 指向之結果檔
        if (opt.nullVal || opt.dropVal) {
            let rewrite = opt.nullVal ? 'o.metrics.ext.nullRecentAct = null' : 'delete o.metrics.ext.nullRecentAct'
            inject += [
                'import fs from \'fs\'',
                'let outIdx = process.argv.indexOf(\'--out\')',
                'if (outIdx >= 0) {',
                '    let outFp = path.resolve(process.argv[outIdx + 1])',
                '    let w0 = fs.writeFileSync',
                '    fs.writeFileSync = function (fp, data, ...rest) {',
                '        if (typeof fp === \'string\' && path.resolve(fp) === outFp && typeof data === \'string\') {',
                '            let o = JSON.parse(data)',
                '            if (o && o.metrics && o.metrics.ext && \'nullRecentAct\' in o.metrics.ext) {',
                `                ${rewrite}`,
                '                data = JSON.stringify(o)',
                '            }',
                '        }',
                '        return w0.call(this, fp, data, ...rest)',
                '    }',
                '}',
                ''
            ].join('\n')
        }
        fs.writeFileSync(path.join(root, 'g_eval.mjs'), `import path from 'path'\nimport { fileURLToPath } from 'url'\n${inject}process.env.ARSI_ROOT = path.dirname(fileURLToPath(import.meta.url))\nawait import(${JSON.stringify(pathToFileURL(path.join(FD_ROOT, 'src', 'cli', 'eval.mjs')).href)})\n`, 'utf8')
        writeSynthLedger(path.join(root, 'data', 'ledger', 'eval'), { n: 60, nBars: 2400, seed: 3 })
        let fp = path.join(root, 'settings.json')
        let st = JSON.parse(fs.readFileSync(fp, 'utf8'))
        st.periods = { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T04:00:00' }, backtest: { start: '2023-02-01T04:00:00', end: '2023-08-05T00:00:00' }, holdoutFrom: '2023-08-05T00:00:00' }
        st.eval = { ...st.eval, warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 8, replicaSeeds: 0, fitEnd: { long: '2022-12-01T08:00:00', short: '2022-12-01T08:00:00' } }
        st.resources = {}
        if (opt.altToolbox) {
            //評估(g_eval.mjs 之子行程)依設定之 records.toolboxDir 載入擴充診斷(未給 = <rsi.root>/toolbox), fakeRound 之「真實診斷」一項取同一個夾(規則 R-EV-45 ⑦ 之解析同評估)⇒
            //  records.toolboxDir 與預設位置不同時, 診斷檔須放 records.toolboxDir 指向之夾才取得到(diagAt: 'alt'); 放預設位置者, 兩處皆不載入
            st.records = { ...st.records, toolboxDir: './rsi/toolbox_alt' }
        }
        if (opt.noToolboxDir) {
            //未給 records.toolboxDir(initProject 之參考設定有給 ./rsi/toolbox): 評估與 fakeRound 皆取 <rsi.root>/toolbox
            st.records = { ...st.records }
            delete st.records.toolboxDir
        }
        fs.writeFileSync(fp, JSON.stringify(st, null, 2), 'utf8')
        if (opt.diag) {
            let dir = opt.diagAt === 'alt' ? path.join(root, 'rsi', 'toolbox_alt', 'metrics') : path.join(root, 'rsi', 'toolbox', 'metrics')
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, `${REAL_DIAG}.mjs`), opt.diag, 'utf8')
        }
        return root
    }
    let run = (root, args = []) => {
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'fakeRound.mjs'), ...args], { cwd: root, env: { ...process.env, ARSI_ROOT: root }, windowsHide: true, encoding: 'utf8', timeout: 170000 })
        return { status: r.status, out: r.stdout, err: r.stderr }
    }
    let lineOf = (out, head) => {
        let l = out.split('\n').find((x) => x.startsWith(head))
        return l === undefined ? null : JSON.parse(l.slice(head.length).trim())
    }
    let FILL_HEAD = '量尺之子集與擴充診斷之補算:'
    let PROBE_HEAD = '自備假診斷之補算(替身評估):'
    let MAIN_ERR = '量尺之子集 / 擴充診斷之補算不如預期'
    let PROBE_ERR = '自備假診斷之補算(替身評估)不如預期'
    let PROBE_OK = { probe: true, threw: true, results: [{ ok: true, filled: ['fakeProbe'] }], calls: 1, again: 0 }

    it('① 專案之共用工具區無該診斷之檔:真實診斷之補算略過(輸出標 skipped 與原因;不計失敗)、離開碼 0、無「不如預期」;自備假診斷之補算 probe: true', () => {
        //R-EV-45 ⑦: 略過不計失敗(1.0.30 為離開碼 15); 自備假診斷不依賴共用工具區
        let r = run(mkRoot('none'))
        assert.equal(r.status, 0, `${r.err}\n${r.out.slice(-800)}`)
        assert(!/不如預期/.test(r.err), r.err)
        assert.deepEqual(lineOf(r.out, FILL_HEAD), { subset: true, fill: 'skipped', skipped: SKIP_NO_FILE })
        assert.deepEqual(lineOf(r.out, PROBE_HEAD), PROBE_OK)
    })

    it('① 同上(--redream --two:補做夢與第 2 輪):離開碼 0、補算之兩行同上', () => {
        let r = run(mkRoot('none2'), ['--redream', '--two'])
        assert.equal(r.status, 0, `${r.err}\n${r.out.slice(-800)}`)
        assert(!/不如預期/.test(r.err), r.err)
        assert.deepEqual(lineOf(r.out, FILL_HEAD), { subset: true, fill: 'skipped', skipped: SKIP_NO_FILE })
        assert.deepEqual(lineOf(r.out, PROBE_HEAD), PROBE_OK)
    })

    it('② 有該診斷之檔而第一個節點無其值(以進入檔刪去結果檔內該診斷之值,造出評估未載入該診斷之節點):略過、原因為「第一個節點無其值」、離開碼 0', () => {
        let r = run(mkRoot('novalue', { diag: DIAG_OK, dropVal: true }))
        assert.equal(r.status, 0, `${r.err}\n${r.out.slice(-800)}`)
        assert(!/不如預期/.test(r.err), r.err)
        assert.deepEqual(lineOf(r.out, FILL_HEAD), { subset: true, fill: 'skipped', skipped: SKIP_NO_VALUE })
        assert.equal(lineOf(r.out, PROBE_HEAD).probe, true)
    })

    it('⑥ 設定之 records.toolboxDir 與預設位置不同(診斷檔只在 records.toolboxDir 指向之夾):「真實診斷」取該夾之診斷檔(同評估之子行程之解析)—— fill: true、值與原本相同、無 skipped、離開碼 0', () => {
        //R-EV-45 ⑦(提案 §7 另見、併入): 評估之子行程依 records.toolboxDir 載入擴充診斷(src/cli/eval.mjs; 未給 = <rsi.root>/toolbox); fakeRound 取檔之夾亦同
        //  改前取 <rsi.root>/toolbox/metrics ⇒ 預設位置無檔 ⇒ 略過(實際有診斷而未被驗)
        let root = mkRoot('toolboxalt', { diag: DIAG_OK, altToolbox: true, diagAt: 'alt' })
        assert(!fs.existsSync(path.join(root, 'rsi', 'toolbox', 'metrics', `${REAL_DIAG}.mjs`)), '預設位置不得有該診斷檔(此案之鑑別前提)')
        let r = run(root)
        assert.equal(r.status, 0, `${r.err}\n${r.out.slice(-800)}`)
        assert(!/不如預期/.test(r.err), r.err)
        let f = lineOf(r.out, FILL_HEAD)
        assert.equal(f.subset, true)
        assert.equal(f.fill, true, JSON.stringify(f))
        assert(!('skipped' in f) && !('valueError' in f), JSON.stringify(f))
        assert.deepEqual(f.results, [{ ok: true, filled: [REAL_DIAG] }])
        assert.equal(f.same, true)
        assert.deepEqual(lineOf(r.out, PROBE_HEAD), PROBE_OK)
    })

    it('⑥ 設定未給 records.toolboxDir(= <rsi.root>/toolbox):「真實診斷」取預設位置之診斷檔 —— fill: true、離開碼 0', () => {
        //R-EV-45 ⑦: 取檔之夾之預設 = <rsi.root>/toolbox(同 src/cli/eval.mjs:433、domain.mjs:449); initProject 之參考設定帶 records.toolboxDir, 此案刪去之以走「未給」之分支
        let root = mkRoot('toolboxnone', { diag: DIAG_OK, noToolboxDir: true })
        assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).records.toolboxDir, undefined, '鑑別前提: 設定未給 records.toolboxDir')
        let r = run(root)
        assert.equal(r.status, 0, `${r.err}\n${r.out.slice(-800)}`)
        let f = lineOf(r.out, FILL_HEAD)
        assert.equal(f.fill, true, JSON.stringify(f))
        assert(!('skipped' in f) && !('valueError' in f), JSON.stringify(f))
        assert.deepEqual(f.results, [{ ok: true, filled: [REAL_DIAG] }])
        assert.equal(f.same, true)
    })

    it('⑥ 同上之反面(records.toolboxDir 與預設位置不同,診斷檔只在預設位置):評估不載入、「真實診斷」亦不取預設位置 —— 略過、原因為「正式之共用工具區無此診斷」、離開碼 0', () => {
        //R-EV-45 ⑦: 取檔之夾與評估載入之夾同一個 ⇒ 預設位置之檔不是「正式之共用工具區」之診斷; 改前取預設位置而見該檔、評估卻未載入 ⇒ 原因為「第一個節點無其值」(兩處不一致之症狀)
        let root = mkRoot('toolboxdefault', { diag: DIAG_OK, altToolbox: true, diagAt: 'default' })
        let r = run(root)
        assert.equal(r.status, 0, `${r.err}\n${r.out.slice(-800)}`)
        assert(!/不如預期/.test(r.err), r.err)
        assert.deepEqual(lineOf(r.out, FILL_HEAD), { subset: true, fill: 'skipped', skipped: SKIP_NO_FILE })
        assert.deepEqual(lineOf(r.out, PROBE_HEAD), PROBE_OK)
    })

    it('③ 有該診斷之檔而診斷拋錯(第一個節點之值為錯誤):不是略過 —— 輸出標 valueError、離開碼 15(同 1.0.30)、stderr 為既有之「量尺之子集 / 擴充診斷之補算不如預期」;自備假診斷仍 probe: true(不誤報為接線有誤)', () => {
        //R-EV-45 ⑦: 值為錯誤者維持失敗(診斷壞了正是假輪次作為升版閘要抓的錯)
        let r = run(mkRoot('throws', { diag: DIAG_THROW }))
        assert.equal(r.status, 15, `${r.err}\n${r.out.slice(-800)}`)
        let f = lineOf(r.out, FILL_HEAD)
        assert.equal(f.subset, true)
        assert.equal(f.fill, false, '值為錯誤 ⇒ fill 為 false(不是 skipped)')
        assert(!('skipped' in f))
        assert(f.valueError.startsWith('該節點之值為錯誤: ') && f.valueError.includes('替身診斷拋錯'), JSON.stringify(f))
        assert(r.err.includes(MAIN_ERR) && !r.err.includes(PROBE_ERR), r.err)
        assert.deepEqual(lineOf(r.out, PROBE_HEAD), PROBE_OK)
    })

    it('③ 有該診斷之檔而診斷載入失敗(用了被禁之時鐘 ⇒ 評估器記為錯誤):同上 —— valueError、離開碼 15', () => {
        let r = run(mkRoot('clock', { diag: DIAG_CLOCK }))
        assert.equal(r.status, 15, `${r.err}\n${r.out.slice(-800)}`)
        let f = lineOf(r.out, FILL_HEAD)
        assert.equal(f.fill, false)
        assert(!('skipped' in f) && typeof f.valueError === 'string' && f.valueError.startsWith('該節點之值為錯誤: '), JSON.stringify(f))
        assert(r.err.includes(MAIN_ERR), r.err)
    })

    it('③ 有該診斷之檔而第一個節點之值為 null(非 undefined 之假值;評估器不產生,以進入檔改寫結果檔造出):不是略過 —— valueError(文字對 null 安全、不拋錯)、離開碼 15(同 1.0.30)', () => {
        //R-EV-45 ⑦: 「無其值」只認 undefined; null、0、false 等其餘非正常之值一律為失敗(1.0.30 亦為離開碼 15)
        let r = run(mkRoot('nullval', { diag: DIAG_OK, nullVal: true }))
        assert.equal(r.status, 15, `${r.err}\n${r.out.slice(-800)}`)
        let f = lineOf(r.out, FILL_HEAD)
        assert.equal(f.subset, true)
        assert.equal(f.fill, false)
        assert(!('skipped' in f), JSON.stringify(f))
        assert.equal(f.valueError, '該節點之值為錯誤: 非診斷之結果(null)')
        assert(r.err.includes(MAIN_ERR) && !/TypeError|Cannot read/.test(r.err), r.err)
        assert.deepEqual(lineOf(r.out, PROBE_HEAD), PROBE_OK)
    })

    it('④ 有該診斷之檔、第一個節點有值,但補算之評估失敗(故障注入:進入檔遇 --ext-only 即離開碼 1):不是略過 —— fill: false、補算結果 ok: false、離開碼 15;自備假診斷仍 probe: true', () => {
        //R-EV-45 ⑦: 「有診斷而補算壞了」仍為失敗; 守住「略過不計失敗」不過寬(補算失敗一律當作略過者必紅)
        let r = run(mkRoot('failfill', { diag: DIAG_OK, failExt: true }))
        assert.equal(r.status, 15, `${r.err}\n${r.out.slice(-800)}`)
        let f = lineOf(r.out, FILL_HEAD)
        assert.equal(f.subset, true)
        assert.equal(f.fill, false)
        assert(!('skipped' in f) && !('valueError' in f), JSON.stringify(f))
        assert.equal(f.results.length, 1)
        assert.equal(f.results[0].ok, false)
        assert(r.err.includes(MAIN_ERR) && !r.err.includes(PROBE_ERR), r.err)
        assert.deepEqual(lineOf(r.out, PROBE_HEAD), PROBE_OK)
    })

    it('⑤ 專案之共用工具區有該診斷(替身檔、值正常):補算之行為與改前相同 —— fill: true、值與原本相同、分數不變、再補不重算、無 skipped、離開碼 0;自備假診斷亦通過', () => {
        let r = run(mkRoot('diag', { diag: DIAG_OK }))
        assert.equal(r.status, 0, `${r.err}\n${r.out.slice(-800)}`)
        assert(!/不如預期/.test(r.err), r.err)
        let f = lineOf(r.out, FILL_HEAD)
        assert.equal(f.subset, true)
        assert.equal(f.fill, true)
        assert(!('skipped' in f) && !('valueError' in f))
        assert.equal(f.threw, true)
        assert.deepEqual(f.results, [{ ok: true, filled: [REAL_DIAG] }])
        assert.equal(f.same, true)
        assert.equal(f.S[0], f.S[1])
        assert.equal(f.again, 0)
        assert.deepEqual(lineOf(r.out, PROBE_HEAD), PROBE_OK)
    })
})
