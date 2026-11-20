import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { makeBacktest } from '../src/domain/backtest.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//全期帳本未建之說明與訊息不指向不存在之旗標(規則 R-EV-45 ⑨; 使用端 Gitea #194 §7 另見之處置)
//  g_build.mjs 只有 --limit、--train, 無 --full; 全期帳本(settings.backtest.ledgerDir, 預設 <privateRoot>/ledger/full)由使用端以聚合入口之 buildLedger 自建,
//  且須與評估帳本用同一個 source.startTime(否則 g_backtest.mjs 離開碼 5)
//  訊息之兩處出口: ① verify 之回測期旗標(makeBacktest().run 之 error 欄)② domain.validatePending(g_rsi.mjs --mode validate 印「未執行: …」)
describe('全期帳本未建之訊息:不指向不存在之 g_build.mjs --full、改指使用端以 buildLedger 自建(規則 R-EV-45 ⑨)', function () {
    this.timeout(60000)
    let t
    let mkSt = (name, backtest) => {
        let st = getSettings()
        let d = path.join(t.dir, name)
        st.rsi.root = path.join(d, 'rsi')
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synth' }), 'utf8')
        //全期帳本之私有根與帳本資料夾皆不建 ⇒ 全期帳本未建
        st.backtest = { ...backtest, privateRoot: path.join(d, 'private') }
        return { st, d }
    }
    before(() => {
        t = makeTmp('fullLedgerHint')
    })
    after(() => {
        t.cleanup()
    })
    //訊息須: 以「全期帳本未建」起首、指向 buildLedger 與 source.startTime(與評估帳本同一個)與帳本之設定鍵 settings.backtest.ledgerDir, 且不含 --full
    let assertMsg = (m, hint) => {
        assert(typeof m === 'string' && m.startsWith('全期帳本未建'), `${hint}: ${m}`)
        assert(!/--full/.test(m), `${hint}: 不得指向不存在之旗標 --full: ${m}`)
        assert(m.includes('buildLedger'), `${hint}: 須指向以聚合入口之 buildLedger 自建: ${m}`)
        assert(m.includes('source.startTime'), `${hint}: 須註明與評估帳本用同一個 source.startTime: ${m}`)
        assert(m.includes('settings.backtest.ledgerDir'), `${hint}: 須註明帳本之位置: ${m}`)
    }

    it('① 回測期旗標之出口(makeBacktest().run):啟用而全期帳本未建 ⇒ error 為新訊息;未啟用者仍為「未啟用」', async () => {
        //R-EV-45 ⑨: 訊息不指向不存在之 g_build.mjs --full
        let { st } = mkSt('bt1', {})
        let r = await makeBacktest({ st, FD_ROOT }).run({ nodeId: 'x', attempt: 1, workDir: t.dir })
        assert.equal(r.flag, null)
        assertMsg(r.error, 'makeBacktest().run')
        let { st: st2 } = mkSt('bt2', { enabled: false })
        let r2 = await makeBacktest({ st: st2, FD_ROOT }).run({ nodeId: 'x', attempt: 1, workDir: t.dir })
        assert.deepEqual({ flag: r2.flag, error: r2.error }, { flag: null, error: '未啟用' })
    })

    it('② 補算旗標之出口(domain.validatePending,即 g_rsi.mjs --mode validate 印「未執行: …」):啟用而全期帳本未建 ⇒ why 為新訊息;未啟用者仍為「回測期旗標未啟用」', async () => {
        let { st, d } = mkSt('vp1', {})
        let P = makeProject(st, { dispatch: async () => ({ ok: false, error: '測試不派工' }), gate: null, catalogFile: path.join(d, 'catalog.json') })
        P.rsi.init()
        let r = await P.validatePending({})
        assert.equal(r.ok, false)
        assertMsg(r.why, 'validatePending')
        let { st: st2, d: d2 } = mkSt('vp2', { enabled: false })
        let P2 = makeProject(st2, { dispatch: async () => ({ ok: false, error: '測試不派工' }), gate: null, catalogFile: path.join(d2, 'catalog.json') })
        P2.rsi.init()
        let r2 = await P2.validatePending({})
        assert.deepEqual({ ok: r2.ok, why: r2.why }, { ok: false, why: '回測期旗標未啟用' })
    })

    it('③ 盤點:套件之程式、說明、合約、樣板與範例內無 g_build.mjs 之 --full(命令列說明 src/cli/rsi.mjs 之 validate 一行改指 buildLedger)', () => {
        //站點全集: src/**、contract/**、examples/**、arms/**(臂目錄之文字)、README.md、settings.json、根目錄之進入檔 g*.mjs(不含 test/、sgud/、docs/〔JSDoc 產物〕、dist/)
        let files = []
        let walk = (dir) => {
            for (let e of fs.readdirSync(dir, { withFileTypes: true })) {
                let fp = path.join(dir, e.name)
                if (e.isDirectory()) {
                    walk(fp)
                }
                else if (/\.(mjs|js|json|md|txt)$/.test(e.name)) {
                    files.push(fp)
                }
            }
        }
        for (let d of ['src', 'contract', 'examples', 'arms']) {
            if (fs.existsSync(path.join(FD_ROOT, d))) {
                walk(path.join(FD_ROOT, d))
            }
        }
        for (let f of fs.readdirSync(FD_ROOT)) {
            if (/^g.*\.mjs$/.test(f) || f === 'README.md' || f === 'settings.json') {
                files.push(path.join(FD_ROOT, f))
            }
        }
        assert(files.length > 50, `盤點之檔數過少(${files.length}), 範圍壞了`)
        let hits = files.filter((fp) => /g_build(\.mjs)?\s+--full/.test(fs.readFileSync(fp, 'utf8'))).map((fp) => path.relative(FD_ROOT, fp))
        assert.deepEqual(hits, [], `仍指向不存在之 g_build.mjs --full: ${hits.join(', ')}`)
        //命令列說明之 validate 一行(原「需先 node g_build.mjs --full」)
        let line = fs.readFileSync(path.join(FD_ROOT, 'src', 'cli', 'rsi.mjs'), 'utf8').split('\n').find((l) => l.includes('--mode validate [--force]'))
        assert(line && line.includes('buildLedger') && line.includes('source.startTime'), String(line))
    })
})
