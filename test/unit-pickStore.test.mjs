/* eslint-disable no-extend-native -- 違約樣本: 本檔刻意暫時改寫內建物件(測後一律以 keepAsync 還原), 驗共同儲存區於挑選模組改內建物件時中止更新 */
import assert from 'assert'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { buildPickStore, infoOf, FIELD_DEFS } from '../src/domain/pickStore.mjs'
import { isIntegrityError } from '../src/eval/intrinsics.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'

describe('共同儲存「自適應挑選策略」區(規則 R-REC-25;保留期只列正負號:R-BT-4)', function () {
    let t
    let st
    let id1 = 'aaaaaaaaaaaaaaa1'
    let id2 = 'bbbbbbbbbbbbbbb2'
    let id3 = 'ccccccccccccccc3'
    let doc = (id, S, extra = {}) => ({
        nodeId: id,
        round: 3,
        attempt: 1,
        status: 'executed',
        spec: { arms: ['A01_nt', 'B14_pitKey'], base: null },
        task: { goal: 'g', type: 'explore' },
        plan: {},
        code: {},
        results: { claimed: {} },
        conclusion: { outcome: 'improved', summary: '結論之摘要  含多餘空白' },
        harness: {
            ok: true,
            summary: [],
            notes: [],
            checks: { issues: ['分數不穩: 假'] },
            score: { S, ladder: 3, flags: { vetoed: false, why: [] } },
            raw: { replays: [{ S: S - 1, comp: 10, recent: 12 }], metrics: { selHash: 'h1', ledgerKey: 'k', ms: { pick: 4200 }, sel: { sigPerPick: 2.5, longRatio: 0.6 }, op: { eqYr: { mean: 12.345, min: -1.2, byPhase: [5, -1.2, 9, 20, 30, 11, 12] }, monthlyOrders: { mean: 100.04 }, peakHold: { max: 30 }, winRate: 0.45678 }, nullSideAct: { excess: 40.26, p: 0.0154 }, ext: { nullRecentAct: { side: { excess: 20.1, p: 0.03 } } } } },
        },
        audit: { round: 3, by: 'm', trust: 'trusted', action: 'accept', evidence: [], issues: [], inactiveArms: ['B14_pitKey'] },
        ...extra,
    })
    before(() => {
        t = makeTmp('pickStore')
        let d = path.join(t.dir, 'proj')
        st = { FD_ROOT: d, rsi: { root: path.join(d, 'rsi') }, records: { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), workDir: path.join(d, 'rsi/work') } }
        for (let k of Object.keys(st.records)) {
            fs.mkdirSync(st.records[k], { recursive: true })
        }
        let pick = (desc) => `export const meta = { arms: ['A01_nt'], params: { take: 40 }, desc: '${desc}' }\nexport default function pick(ctx) {\n    return []\n}\n`
        for (let [id, S] of [[id1, 10.5], [id2, 55.25]]) {
            fs.mkdirSync(path.join(st.records.workDir, id), { recursive: true })
            fs.writeFileSync(path.join(st.records.workDir, id, 'pick.mjs'), pick(`成品 ${id.slice(0, 4)}`), 'utf8')
            fs.writeFileSync(path.join(st.records.nodeDir, `${id}.json`), JSON.stringify(doc(id, S)), 'utf8')
        }
        //無迴圈重跑結果之節點(失敗者)不收
        fs.writeFileSync(path.join(st.records.nodeDir, `${id3}.json`), JSON.stringify({ ...doc(id3, 1), harness: { ok: false, error: '未交付' } }), 'utf8')
        //做夢之家族歸類(取最近一份)
        fs.writeFileSync(path.join(st.records.dreamDir, 'r003.json'), JSON.stringify({ round: 3, synthesis: { overview: { families: [{ name: '家族甲', nodes: [id2.slice(0, 8)] }] } } }), 'utf8')
    })
    after(() => {
        t.cleanup()
    })

    it('infoOf:欄位取自迴圈重跑之數字(不是 agent 自報);挑選內容 = 內建與近 90 日之超額及其均;缺欄為 null 而不拋錯', () => {
        let x = infoOf(doc(id1, 10.5), { meta: { desc: 'd', params: { a: 1 } }, fam: '家族甲', ho: { perf: '+', content: '-', asOf: '2026-11-10T00:00:00' }, storeRel: 'rsi/picks' })
        assert.deepEqual([x.id, x.short, x.round, x.type, x.base, x.family], [id1, id1.slice(0, 8), 3, 'explore', null, '家族甲'])
        assert.deepEqual([x.status.trust, x.status.action, x.status.vetoed, x.status.ladder, x.status.inactiveArms], ['trusted', 'accept', false, 3, ['B14_pitKey']])
        assert.deepEqual([x.backtest.S, x.backtest.eqYrMean, x.backtest.eqYrMin, x.backtest.nPosPhases], [10.5, 12.35, -1.2, 6])
        assert.deepEqual(x.backtest.content, { builtin: 40.3, p: 0.0154, recent: 20.1, pRecent: 0.03, mean: 30.2 })
        assert.deepEqual([x.backtest.monthlyOrders, x.backtest.peakHold, x.backtest.winRate, x.backtest.pickSec, x.backtest.selHash], [100, 30, 0.4568, 4.2, 'h1'])
        assert.deepEqual(x.backtest.replays, [{ S: 9.5, builtin: 10, recent: 12 }])
        assert.deepEqual(x.holdout, { perf: '+', content: '-', asOf: '2026-11-10T00:00:00' })
        assert.deepEqual([x.design.desc, x.design.params, x.design.summary], ['d', { a: 1 }, '結論之摘要 含多餘空白'])
        assert.equal(x.files.pick, `rsi/picks/${id1}/pick.mjs`)
        //舊節點文件缺欄: 不拋錯, 值為 null; 未給保留期者三欄皆 null
        let y = infoOf({ nodeId: id2, round: 1, spec: { arms: ['A01_nt'], base: null }, harness: { ok: true, score: { S: 1 } } })
        assert.deepEqual([y.backtest.eqYrMean, y.backtest.content.mean, y.status.trust, y.design.desc], [null, null, null, null])
        assert.deepEqual(y.holdout, { perf: null, content: null, asOf: null })
    })

    it('buildPickStore:只收有迴圈重跑結果且有交付版者;程式碼逐位複製;總表依 S 由高至低;重跑時內容不變者不重複製', async () => {
        let r = await buildPickStore(st)
        assert.deepEqual([r.n, r.copied, r.holdoutSigned], [2, 2, 0])
        assert(r.skipped.some((s) => s.startsWith(id3.slice(0, 8))), JSON.stringify(r.skipped))
        let dir = path.join(st.rsi.root, 'picks')
        for (let id of [id1, id2]) {
            assert(fs.readFileSync(path.join(dir, id, 'pick.mjs')).equals(fs.readFileSync(path.join(st.records.workDir, id, 'pick.mjs'))), '程式碼為逐位複本')
            assert.equal(JSON.parse(fs.readFileSync(path.join(dir, id, 'info.json'), 'utf8')).id, id)
        }
        assert(!fs.existsSync(path.join(dir, id3)), '無結果之節點不建夾')
        let idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
        assert.deepEqual(idx.items.map((x) => x.id), [id2, id1], '依 S 由高至低')
        assert.deepEqual([idx.items[0].family, idx.items[1].family, idx.items[0].design.desc], ['家族甲', null, `成品 ${id2.slice(0, 4)}`])
        assert.equal(idx.fields.length, FIELD_DEFS.length)
        let md = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8')
        assert(md.indexOf(`\`${id2.slice(0, 8)}\``) < md.indexOf(`\`${id1.slice(0, 8)}\``) && md.includes('· / ·'), '總表之次序與未算之保留期欄')
        assert(fs.readFileSync(path.join(dir, 'README.md'), 'utf8').includes('只提供正負號'))
        assert.equal((await buildPickStore(st)).copied, 0, '內容未變則不重複製')
        fs.appendFileSync(path.join(st.records.workDir, id1, 'pick.mjs'), '// 改版\n')
        assert.equal((await buildPickStore(st)).copied, 1, '交付版有變(重做)⇒ 更新複本')
    })

    it('保留期之正負號:讀 _holdout.json(主控之檢定工具所寫;只有正負號)併入各策略;重產時不刪、不改該檔;未列者維持 null', async () => {
        let dir = path.join(st.rsi.root, 'picks')
        let fp = path.join(dir, '_holdout.json')
        let text = JSON.stringify({ from: '2026-08-01T00:00:00', asOf: '2026-11-10T00:00:00', items: { [id2]: { perf: '+', content: '-' } } })
        fs.writeFileSync(fp, text, 'utf8')
        let r = await buildPickStore(st)
        assert.equal(r.holdoutSigned, 1)
        assert.equal(fs.readFileSync(fp, 'utf8'), text, '正負號檔原樣保留')
        let idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
        let by = Object.fromEntries(idx.items.map((x) => [x.id, x.holdout]))
        assert.deepEqual(by[id2], { perf: '+', content: '-', asOf: '2026-11-10T00:00:00' })
        assert.deepEqual(by[id1], { perf: null, content: null, asOf: null })
        assert.equal(idx.holdoutAsOf, '2026-11-10T00:00:00')
        let md = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8')
        assert(md.includes('| + / - |') && md.includes('| · / · |'))
        //共同儲存區內不得出現保留期之數字欄: 各策略之 holdout 只有 perf / content / asOf 三鍵
        assert(idx.items.every((x) => Object.keys(x.holdout).sort().join(',') === 'asOf,content,perf'))
    })
})

//keepAsync, 先記下要被改之屬性描述, fn 結束後(含拋錯)還原(新增者刪除)
let keepAsync = async (targets, fn) => {
    let saved = targets.map(([o, k]) => [o, k, Object.getOwnPropertyDescriptor(o, k)])
    try {
        return await fn()
    }
    finally {
        for (let [o, k, d] of saved) {
            if (d) {
                Object.defineProperty(o, k, d)
            }
            else {
                delete o[k]
            }
        }
    }
}
//snapOf, 資料夾內全部檔之 { 相對路徑 → 內容之雜湊 }(含空夾之存在以 '/' 結尾之鍵列出)
let snapOf = (dir) => {
    let out = {}
    let walk = (d, rel) => {
        for (let ent of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            let r = rel ? `${rel}/${ent.name}` : ent.name
            if (ent.isDirectory()) {
                out[`${r}/`] = ''
                walk(path.join(d, ent.name), r)
            }
            else {
                out[r] = crypto.createHash('sha1').update(fs.readFileSync(path.join(d, ent.name))).digest('hex')
            }
        }
    }
    walk(dir, '')
    return out
}

describe('共同儲存區:挑選模組載入時改了內建物件(EVAL_INTEGRITY)⇒ 中止該次更新並記錄(規則 R-REC-25、R-EV-35 ②)', function () {
    //迴圈行程內(輪末)以 loadPick 載入各節點之成品取 meta, 模組之頂層程式於本行程執行; 內建物件被改即完整性錯誤。原為吞錯(meta = null 後照常寫入), 本行程之內建物件可能保持被改
    let t
    let st
    let fpOf
    let ida = 'aaaaaaaaaaaaaaa1'
    let idb = 'bbbbbbbbbbbbbbb2'
    let idc = 'ccccccccccccccc3'
    let clean = (desc) => `export const meta = { arms: ['A01_nt'], params: { take: 40 }, desc: '${desc}' }\nexport default function pick(ctx) {\n    return []\n}\n`
    let doc = (id, S) => ({
        nodeId: id,
        round: 3,
        attempt: 1,
        status: 'executed',
        spec: { arms: ['A01_nt'], base: null },
        task: { goal: 'g', type: 'explore' },
        conclusion: { outcome: 'improved', summary: '摘要' },
        harness: { ok: true, summary: [], notes: [], checks: { issues: [] }, score: { S, ladder: 3, flags: { vetoed: false, why: [] } }, raw: { replays: [], metrics: {} } },
    })
    beforeEach(() => {
        t = makeTmp('pickStoreIntegrity')
        let d = path.join(t.dir, 'proj')
        st = { FD_ROOT: d, rsi: { root: path.join(d, 'rsi') }, records: { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), workDir: path.join(d, 'rsi/work') } }
        for (let k of Object.keys(st.records)) {
            fs.mkdirSync(st.records[k], { recursive: true })
        }
        fpOf = (id) => path.join(st.records.workDir, id, 'pick.mjs')
        for (let [id, S] of [[ida, 10], [idb, 20], [idc, 30]]) {
            fs.mkdirSync(path.join(st.records.workDir, id), { recursive: true })
            fs.writeFileSync(fpOf(id), clean(`成品 ${id.slice(0, 4)}`), 'utf8')
            fs.writeFileSync(path.join(st.records.nodeDir, `${id}.json`), JSON.stringify(doc(id, S)), 'utf8')
        }
    })
    afterEach(() => {
        t.cleanup()
    })

    it('某節點之模組頂層改內建物件 ⇒ buildPickStore 拋 code 為 EVAL_INTEGRITY 之錯誤(訊息指明節點與被改之項目)、不寫入任何檔(含該節點之前已處理者之複本與 info.json、index.json、INDEX.md);模組改回合法後重新產生照常', async () => {
        let dir = path.join(st.rsi.root, 'picks')
        assert.equal((await buildPickStore(st)).n, 3)
        let before = snapOf(dir)
        //ida(排在 idb 之前): 交付版改版 —— 原流程於載入 idb 之前已複製並寫 info.json; idb: 頂層改 Math.trunc; idc: 不變
        fs.appendFileSync(fpOf(ida), '// 改版\n')
        fs.writeFileSync(fpOf(idb), `Math.trunc = Math.floor\n${clean('壞成品')}`, 'utf8')
        let err = await keepAsync([[Math, 'trunc']], async () => {
            try {
                await buildPickStore(st)
            }
            catch (e) {
                return e
            }
            return null
        })
        assert(err instanceof Error, '須拋錯(不得吞掉完整性錯誤)')
        assert.equal(err.code, 'EVAL_INTEGRITY')
        assert(err.message.includes(idb.slice(0, 8)), `訊息須指明節點: ${err.message}`)
        assert(err.message.includes('Math.trunc') && err.message.includes('pick-load'), `訊息須帶被改之項目與偵測點: ${err.message}`)
        assert(!err.message.includes(t.dir), '訊息不帶本機路徑')
        //以 intrinsics.mjs 之 integrityError 建立(只用擷取之參照): 為評估器之完整性錯誤(身分可辨識)、凍結, where / items 同原錯誤
        assert(isIntegrityError(err) && Object.isFrozen(err) && err.where === 'pick-load' && err.items.includes('Math.trunc'))
        assert(err.message.startsWith('EVAL_INTEGRITY 共同儲存區之更新已中止(未寫入任何檔): 節點 '), err.message)
        assert.deepEqual(snapOf(dir), before, '中止 ⇒ 區內之檔與內容皆不變(包含 ida 之 pick.mjs 複本未更新)')
        //Math.trunc 已還原(keepAsync), 模組改回合法 ⇒ 重新產生: ida、idb 之交付版皆更新
        fs.writeFileSync(fpOf(idb), clean('好成品'), 'utf8')
        let r = await buildPickStore(st)
        assert.deepEqual([r.n, r.copied], [3, 2])
        assert(fs.readFileSync(path.join(dir, ida, 'pick.mjs'), 'utf8').endsWith('// 改版\n'))
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, idb, 'info.json'), 'utf8')).design.desc, '好成品')
    })

    it('首次產生時某節點之模組改內建物件 ⇒ 拋錯且不建任何檔(區夾不存在或為空)', async () => {
        fs.writeFileSync(fpOf(idc), `Math.trunc = Math.floor\n${clean('壞成品')}`, 'utf8')
        let err = await keepAsync([[Math, 'trunc']], async () => {
            try {
                await buildPickStore(st)
            }
            catch (e) {
                return e
            }
            return null
        })
        assert(err && err.code === 'EVAL_INTEGRITY' && err.message.includes(idc.slice(0, 8)), String(err && err.message))
        let dir = path.join(st.rsi.root, 'picks')
        assert(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, '不留任何檔')
    })

    it('其他錯誤之處置不變:靜態檢查未過、匯入時拋錯之成品 ⇒ meta 為 null(design.desc 為 null)、仍收錄、不拋錯;其餘節點照常', async () => {
        fs.writeFileSync(fpOf(ida), `import fs from 'fs'\n${clean('含 import')}`, 'utf8')
        fs.writeFileSync(fpOf(idb), `throw new Error('頂層拋錯')\n${clean('拋錯')}`, 'utf8')
        let r = await buildPickStore(st)
        assert.deepEqual([r.n, r.copied], [3, 3])
        let idx = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', 'index.json'), 'utf8'))
        let by = Object.fromEntries(idx.items.map((x) => [x.id, x.design]))
        assert.equal(by[ida].desc, null)
        assert.equal(by[idb].desc, null)
        assert.equal(by[idc].desc, `成品 ${idc.slice(0, 4)}`)
    })

    it('延後執行之程式(微任務)於 loadPick 內之比對之後、buildPickStore 恢復之前改內建物件 ⇒ 寫檔前偵測到:不論延後幾個微任務, 寫檔(含建夾)時內建物件皆未被改;被偵測者不寫任何檔', async () => {
        //R-EV-35 ②: 每個 await 恢復後、處理資料前亦比對(loadPick 內之比對之後才執行之延後程式, 於 loadPick 之 await 恢復間改了內建物件, 原流程照常寫檔)
        const orig = Math.trunc
        let dir = path.join(st.rsi.root, 'picks')
        let wf = fs.writeFileSync
        let mk = fs.mkdirSync
        let spying = false
        let seen = []
        let tick = () => new Promise((resolve) => setImmediate(resolve))
        let outcomes = []
        try {
            fs.writeFileSync = (...a) => {
                if (spying) {
                    seen.push(Math.trunc !== orig)
                }
                return wf(...a)
            }
            fs.mkdirSync = (...a) => {
                if (spying) {
                    seen.push(Math.trunc !== orig)
                }
                return mk(...a)
            }
            for (let target of [idb, idc]) {
                for (let k = 0; k <= 40; k++) {
                    fs.rmSync(dir, { recursive: true, force: true })
                    seen.length = 0
                    fs.writeFileSync(fpOf(target), `Promise.resolve()${'.then(() => 0)'.repeat(k)}.then(() => { Math.trunc = Math.floor })\n${clean(`延後 ${k}`)}`, 'utf8')
                    //匯入以「路徑 + 原始碼之內容雜湊」為鍵快取(規則 R-EV-39): 每個目標與每個延後數 k 之內容皆不同(含 k), 模組之頂層程式每次重新執行
                    let err = null
                    spying = true
                    try {
                        await buildPickStore(st)
                    }
                    catch (e) {
                        err = e
                    }
                    spying = false
                    await tick()
                    Math.trunc = orig
                    if (err) {
                        assert(isIntegrityError(err), `${target.slice(0, 4)} k=${k}: ${String(err && err.message)}`)
                        assert.equal(seen.length, 0, `${target.slice(0, 4)} k=${k}: 被偵測者不得寫任何檔`)
                        outcomes.push(err.where)
                    }
                    else {
                        assert(seen.length > 0 && seen.every((x) => x === false), `${target.slice(0, 4)} k=${k}: 寫檔時內建物件已被改: ${JSON.stringify(seen)}`)
                        outcomes.push('ok')
                    }
                }
                fs.writeFileSync(fpOf(target), clean('還原'), 'utf8')
            }
        }
        finally {
            spying = false
            fs.writeFileSync = wf
            fs.mkdirSync = mk
            Math.trunc = orig
        }
        //窗口確被命中(否則本案無意義): 至少有一個延後數使 loadPick 內之比對漏掉、而於 buildPickStore 恢復後才偵測到(where = pick-store); 也有被 loadPick 內之比對偵測到者與延後到寫檔之後者
        assert(outcomes.includes('pick-store'), `未命中 loadPick 之後之窗口: ${JSON.stringify(outcomes)}`)
        assert(outcomes.includes('pick-load') && outcomes.includes('ok'), JSON.stringify(outcomes))
    })

    it('同行程之內建物件已被改(前次更新載入之成品所改, 行程不終止)⇒ 本次更新於入口即中止:各候選皆於載入前被拒(靜態檢查未過)或無候選亦然, 不寫任何檔;改回後照常', async () => {
        //R-EV-35 ②: 迴圈行程於輪末之呼叫端攔下錯誤後繼續; 其後之更新不得在被改之內建物件下寫檔
        let dir = path.join(st.rsi.root, 'picks')
        let errs = []
        let tryBuild = async () => {
            try {
                await buildPickStore(st)
            }
            catch (e) {
                errs.push(e)
                return
            }
            errs.push(null)
        }
        fs.writeFileSync(fpOf(idb), `Math.trunc = Math.floor\n${clean('壞成品')}`, 'utf8')
        await keepAsync([[Math, 'trunc']], async () => {
            await tryBuild() //載入 idb 時改了內建物件 ⇒ 中止(Math.trunc 保持被改)
            for (let id of [ida, idb, idc]) {
                fs.writeFileSync(fpOf(id), `import fs from 'fs'\n${clean('靜態檢查未過')}`, 'utf8')
            }
            await tryBuild() //各候選皆於載入前被拒 ⇒ 載入後之比對不會執行, 須由入口比對偵測
            for (let id of [ida, idb, idc]) {
                fs.rmSync(path.join(st.records.nodeDir, `${id}.json`))
            }
            await tryBuild() //無候選
        })
        assert.equal(errs.length, 3)
        assert(errs.every((e) => e && isIntegrityError(e) && e.code === 'EVAL_INTEGRITY'), errs.map((e) => String(e && e.message)).join(' | '))
        assert.deepEqual(errs.map((e) => e.where), ['pick-load', 'pick-store', 'pick-store'])
        assert(!fs.existsSync(dir), '三次皆不寫任何檔(區夾亦不建)')
        //內建物件改回、候選改回 ⇒ 照常
        for (let [id, S] of [[ida, 10], [idb, 20], [idc, 30]]) {
            fs.writeFileSync(fpOf(id), clean(`成品 ${id.slice(0, 4)}`), 'utf8')
            fs.writeFileSync(path.join(st.records.nodeDir, `${id}.json`), JSON.stringify(doc(id, S)), 'utf8')
        }
        assert.equal((await buildPickStore(st)).n, 3)
    })

    it('偵測到被改之後建立之錯誤不經被改之內建物件:成品把全域 Error 換成會拋出字串之函數、或把 String.prototype.slice 換成會拋錯之函數 ⇒ 仍拋評估器之完整性錯誤(code 為 EVAL_INTEGRITY、指明節點), 不寫任何檔', async () => {
        let dir = path.join(st.rsi.root, 'picks')
        for (let [nm, code, target, item] of [
            ['Error', 'Error = function () { throw "constructor-poison" }', [globalThis, 'Error'], 'globalThis.Error'],
            ['String.prototype.slice', 'String.prototype.slice = function () { throw "slice-poison" }', [String.prototype, 'slice'], 'String.prototype.slice'],
            ['Array.prototype.push', 'Array.prototype.push = function () { throw "push-poison" }', [Array.prototype, 'push'], 'Array.prototype.push'],
            //說明(note)轉字串須用擷取之 String(不經全域 String)
            ['String', 'String = function () { throw "string-poison" }', [globalThis, 'String'], 'globalThis.String'],
        ]) {
            fs.writeFileSync(fpOf(idb), `${code}\n${clean('壞成品')}`, 'utf8')
            let err = await keepAsync([target], async () => {
                try {
                    await buildPickStore(st)
                }
                catch (e) {
                    return e
                }
                return null
            })
            assert(err && isIntegrityError(err), `${nm}: ${typeof err === 'string' ? err : String(err && err.message)}`)
            assert.equal(err.code, 'EVAL_INTEGRITY', nm)
            assert(err.message.includes(idb.slice(0, 8)) && err.message.includes(item), `${nm}: ${err.message}`)
            assert(!fs.existsSync(dir), `${nm}: 不寫任何檔`)
        }
    })

    it('第二段複製之交付版 = 載入前讀入之那一份, 第二段不再讀來源檔(第一段全部載入後來源檔被改動 ⇒ 複本與 info.json 仍為載入時之版本;載入器自行讀檔後匯入,讀檔與匯入之間來源檔被改動者不在此保證內)', async () => {
        let dir = path.join(st.rsi.root, 'picks')
        let rf = fs.readFileSync
        let mk = fs.mkdirSync
        let phase2 = false
        let want = clean('載入時之版本')
        fs.writeFileSync(fpOf(ida), want, 'utf8')
        try {
            //第二段之第一個動作為建區夾: 此後讀來源檔者得到另一份內容(模擬載入後、複製前被其他寫入者改動)
            fs.mkdirSync = (...a) => {
                if (path.resolve(String(a[0])) === path.resolve(dir)) {
                    phase2 = true
                }
                return mk(...a)
            }
            fs.readFileSync = (...a) => (phase2 && path.resolve(String(a[0])) === path.resolve(fpOf(ida)) ? Buffer.from(clean('載入後被改之版本')) : rf(...a))
            assert.equal((await buildPickStore(st)).n, 3)
        }
        finally {
            fs.readFileSync = rf
            fs.mkdirSync = mk
        }
        assert.equal(fs.readFileSync(path.join(dir, ida, 'pick.mjs'), 'utf8'), want, '複本 = 載入前讀入之那一份')
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ida, 'info.json'), 'utf8')).design.desc, '載入時之版本', 'info.json 之 meta 取自載入時之版本')
    })

    it('命令列 src/tools/pickStore.mjs:挑選模組改內建物件 ⇒ 輸出 ERROR EVAL_INTEGRITY 與節點、離開碼 3、區內之檔不變;合法者離開碼 0', () => {
        let root = st.FD_ROOT
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
            eval: { ledgerDir: './ledger' },
            rsi: { root: './rsi' },
            records: { nodeDir: './rsi/records/nodes', dreamDir: './rsi/records/dreams', workDir: './rsi/work' },
            dispatch: {},
        }), 'utf8')
        let run = () => {
            let env = { ...process.env, ARSI_ROOT: root }
            delete env.ARSI_HARNESS
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'pickStore.mjs')], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
        }
        let r0 = run()
        assert.equal(r0.status, 0, r0.out.slice(0, 800))
        assert(/策略 3 個/.test(r0.out))
        let dir = path.join(st.rsi.root, 'picks')
        let before = snapOf(dir)
        fs.appendFileSync(fpOf(ida), '// 改版\n')
        fs.writeFileSync(fpOf(idb), `Math.trunc = Math.floor\n${clean('壞成品')}`, 'utf8')
        let r1 = run()
        assert.equal(r1.status, 3, r1.out.slice(0, 800))
        assert(/ERROR EVAL_INTEGRITY/.test(r1.out) && r1.out.includes(idb.slice(0, 8)) && /Math\.trunc/.test(r1.out), r1.out.slice(0, 800))
        assert.deepEqual(snapOf(dir), before)
    })
})
