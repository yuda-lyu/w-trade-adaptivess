import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { FD_ROOT, makeTmp } from './tools/synthLedger.mjs'


//評估環境之鍵改變後(帳本重建而帳本鍵改變)之重做與展開: 節點 id = 規格與評估環境之鍵之雜湊, 舊節點經全樹重算保留其 id(與現行之 idOf(spec) 不同)
//  ①重做舊節點: 任務之準備(工作夾、起點與參考成品之複本、參考清單之「不含自己」、隨機對照之組別)須依樹上之 id(呼叫端給), 不依 idOf(spec)
//  ②自舊節點以算子展開: 子規格之起點須為父節點於樹上之 id(存在、閘門通過)
//  ③評估環境之鍵未變時: 與未修改時相同(taskFor 給或不給 nodeId 之結果相同、子規格之起點 = idOf)
//  接縫不用替身: 真 w-recursi + 本套件真實之領域(makeProject → reverifyAll → verify → 子行程之評估入口; 輪末鉤子 → 做夢 → 重做 → runNode); 只有派工換成假的
//  合成資料: 合成帳本(seed 7 → 8 ⇒ 帳本鍵改變)、三個挑選模組各異(選集各異)
describe('評估環境之鍵改變後之重做與展開(節點 id 依樹上者)', function () {
    this.timeout(600000)
    let t
    before(() => {
        t = makeTmp('reworkId')
    })
    after(() => {
        t.cleanup()
    })

    it('重建帳本(鍵改變)→ reverifyAll → 做夢判舊節點重做:工作夾與複本皆在樹上之 id 之夾、參考不含自己、沿用組別、無多出之工作夾;算子自舊節點展開之起點存在且閘門通過、乾跑之計畫不被拒;鍵未變時行為不變', function () {
        let root = path.join(t.dir, 'rw')
        fs.mkdirSync(root, { recursive: true })
        let SRC = pathToFileURL(path.join(FD_ROOT, 'src')).href + '/'
        let SYN = pathToFileURL(path.join(FD_ROOT, 'test', 'tools', 'synthLedger.mjs')).href
        let base = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        let ld = path.join(root, 'ledger', 'eval')
        let settings = {
            ...base,
            periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' }, holdoutFrom: '2099-01-01T00:00:00' },
            source: { libraryRoot: path.join(root, 'nolib'), keyOhlc: 'SYM_4hr', barHours: 4 },
            eval: { ledgerDir: ld, replicaSeeds: 0, warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 4, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 }, timeoutSec: 900 },
            backtest: { ...base.backtest, enabled: false },
            rsi: { ...base.rsi, root: path.join(root, 'rsi') },
            records: { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work'), toolboxDir: path.join(root, 'rsi/toolbox') },
        }
        fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
        fs.mkdirSync(path.join(root, 'arms'), { recursive: true })
        fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(root, 'arms', 'base.json'))
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings), 'utf8')
        fs.writeFileSync(path.join(root, 'g_eval.mjs'), `import path from 'path'\nimport { fileURLToPath } from 'url'\nprocess.env.ARSI_ROOT = path.dirname(fileURLToPath(import.meta.url))\nawait import(${JSON.stringify(SRC + 'cli/eval.mjs')})\n`, 'utf8')
        fs.writeFileSync(path.join(root, 'child.mjs'), `import fs from 'fs'
import path from 'path'
let { getSettings } = await import(${JSON.stringify(SRC + 'cfg.mjs')})
let { makeProject } = await import(${JSON.stringify(SRC + 'domain/domain.mjs')})
let { specHash } = await import(${JSON.stringify(SRC + 'engineApi.mjs')})
let { writeSynthLedger } = await import(${JSON.stringify(SYN)})
let root = process.env.ARSI_ROOT
let ld = path.join(root, 'ledger', 'eval')
let wk = path.join(root, 'rsi', 'work')
writeSynthLedger(ld, { n: 60, nBars: 2400, seed: 7 })
let obs = []
let mode = { rework: null }
let dispatch = async (role, { prompt, logFile }) => {
    if (role === 'dream') {
        let m = /請閱讀 (\\S+)\\/brief\\.md/.exec(prompt)
        let wd = path.resolve(root, m[1])
        let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
        let dream = {
            audits: tpl.audits.map((a) => (a.nodeId === mode.rework ? { nodeId: a.nodeId, trust: 'partial', action: 'rework', evidence: ['假審計'], issues: ['假'], reworkBrief: '請重做(假)' } : { nodeId: a.nodeId, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [] })),
            synthesis: { summary: '假做夢', worked: [], failed: [], patterns: [], prevDirections: [] },
            guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: [] },
            expansion: [],
            docsUpdated: [],
        }
        fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
        return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
    }
    //節點: 記下派工當下之工作夾與其檔、各工作夾、任務書所指之複本; 回額度用盡(停在派工, 不重跑驗證; 節點文件記下任務)
    let wd = path.dirname(logFile)
    let ls = (d) => fs.readdirSync(d).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort()
    let brief = fs.readFileSync(path.join(wd, 'brief.md'), 'utf8')
    obs.push({ wd: path.basename(wd), files: ls(wd), dirs: fs.readdirSync(wk).sort(), copies: [...brief.matchAll(/rsi\\/work\\/([0-9a-f]+)\\/(base_pick|ref_[0-9a-f]+)\\.mjs/g)].map((x) => x[1] + '/' + x[2] + '.mjs') })
    return { ok: false, quota: true, error: 'fake stop at dispatch' }
}
let mkP = () => makeProject(getSettings(), { dispatch, gate: null, catalogFile: path.join(root, 'catalog.json') })
let P = mkP()
P.rsi.init()
let [A1, A2, A3] = P.selectable.slice(0, 3).map((a) => a.id)
let s1 = { arms: [A1], base: null }
let id1 = P.idOf(s1)
let s3 = { arms: [A3], base: null }
let id3 = P.idOf(s3)
let s2 = { arms: [A1, A2].sort(), base: id1 }
let id2 = P.idOf(s2)
let hyp = { arms: [A2, A3].sort(), base: null }
let PICK = (arms, k) => "export const meta = { arms: " + JSON.stringify(arms) + " }\\nexport default function pick(ctx) { return [1, 5, 9, 13, 17, 21, 25].map((s) => (s * " + k + " + ctx.k) % ctx.n) }\\n"
let mkDoc = (nodeId, spec, trial) => P.records.putNodeDoc({ nodeId, round: 1, attempt: 1, status: 'executed', createdAt: new Date().toISOString(), spec, task: { trial }, agent: null, plan: null, code: null, results: null, conclusion: null, harness: { ok: true, summary: [], notes: [], score: null, fingerprint: null, checks: { issues: [] }, validation: null, raw: null, evalJson: null, error: null }, audit: null, history: [] })
for (let [id, spec, k, parent, trial] of [[id1, s1, 1, 'root', null], [id2, s2, 3, id1, { id: 'T1', variant: 'B' }], [id3, s3, 7, 'root', null]]) {
    P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parent, round: 1, raw: { attempt: 1 } })
    fs.mkdirSync(path.join(wk, id), { recursive: true })
    fs.writeFileSync(path.join(wk, id, 'pick.mjs'), PICK(spec.arms, k), 'utf8')
    mkDoc(id, spec, trial)
}
let res = { ids: { id1, id2, id3 }, env0: P.envKey }
res.rv0 = (await P.reverifyAll({ why: 'before' })).map((r) => ({ nodeId: r.nodeId, ok: r.ok }))
P.rsi.setEvidence(id1, { trust: 'trusted' })
P.rsi.setEvidence(id3, { trust: 'trusted' })
let op = (Q, name) => Q.domain.operators.find((o) => o.name === name)
let J = (x) => JSON.parse(JSON.stringify(x))
//③鍵未變: 給或不給 nodeId(= idOf)之任務相同; 子規格之起點 = idOf(spec)(樹上者與假設之規格皆然)
res.same = {
    task: JSON.stringify(J(P.taskFor(s2, null))) === JSON.stringify(J(P.taskFor(s2, null, { nodeId: id2 }))),
    trial: P.taskFor(s2, null).trial,
    selfInRefs: P.taskFor(s2, null).refs.some((r) => r.nodeId === id2),
    refine: op(P, 'refine').children(s2)[0].spec.base === id2,
    add: op(P, 'add:' + A3).children(s1)[0].spec.base === id1,
    hyp: op(P, 'refine').children(hyp)[0].spec.base === P.idOf(hyp),
}
//以不同之帳本鍵重建帳本(合成帳本 seed 7 → 8)
writeSynthLedger(ld, { n: 60, nBars: 2400, seed: 8 })
let P2 = mkP()
res.env1 = P2.envKey
res.idNew = { id1: P2.idOf(s1), id2: P2.idOf(s2) }
res.rv1 = (await P2.reverifyAll({ why: 'ledger rebuilt' })).map((r) => ({ nodeId: r.nodeId, ok: r.ok }))
res.idsAfter = P2.rsi.store.listIndex().map((x) => x.id).sort()
res.dirsAfterReverify = fs.readdirSync(wk).sort()
//同規格之非已執行之存根(id 排在前): 起點取已執行者
P2.rsi.store.putNode({ id: '0stub-same-spec', spec: s1, specHash: specHash(s1), status: 'rejectedByGate', parent: 'root', round: 2 })
//快速路徑命中之節點非已執行(鍵改變後同規格又以新 id 入樹而被閘門拒絕之存根)而同規格之舊節點 n1 為已執行者 ⇒ 起點取已執行者
P2.rsi.store.putNode({ id: P2.idOf(s1), spec: s1, specHash: specHash(s1), status: 'rejectedByGate', parent: 'root', round: 2 })
//快速路徑命中之節點非已執行而同規格無已執行者(只有另一個非已執行之舊節點,其 id 排在前)⇒ 仍為命中之節點(不取舊之非已執行者)
let s4 = { arms: [A2], base: null }
P2.rsi.store.putNode({ id: '-old-s4', spec: s4, specHash: specHash(s4), status: 'rejectedByGate', parent: 'root', round: 1 })
P2.rsi.store.putNode({ id: P2.idOf(s4), spec: s4, specHash: specHash(s4), status: 'rejectedByGate', parent: 'root', round: 2 })
//同規格之已執行之孿生(id 排在 n3 之後; 供「對照表所選之 id 已不在樹上 ⇒ 重建一次再取」)
P2.rsi.store.putNode({ id: 'zz-s3-twin', spec: s3, specHash: specHash(s3), status: 'executed', parent: 'root', round: 1, raw: { attempt: 1 } })
//②展開
let view = { nodes: P2.rsi.store.listIndex() }
let refine = op(P2, 'refine').children(s2)[0]
let add3 = op(P2, 'add:' + A3).children(s1)[0]
res.expand = {
    refine: { base: refine.spec.base, exists: P2.rsi.store.hasNode(refine.spec.base), gate: P2.domain.gates.pre(refine.spec, { view }), reason: refine.reason },
    add: { base: add3.spec.base, gate: P2.domain.gates.pre(add3.spec, { view }), reason: add3.reason },
    hyp: op(P2, 'refine').children(hyp)[0].spec.base === P2.idOf(hyp),
    //快速路徑命中之存根: 鑑別前提(存根確為現行 id、非已執行;同規格之 n1 為已執行;存根之 id 與 n1 不同)與結果
    stub: { id: P2.idOf(s1), exists: P2.rsi.store.hasNode(P2.idOf(s1)), status: P2.rsi.store.getNode(P2.idOf(s1)).status, n1Status: P2.rsi.store.getNode(id1).status },
    noExec: { id: P2.idOf(s4), idStatus: P2.rsi.store.getNode(P2.idOf(s4)).status, oldStatus: P2.rsi.store.getNode('-old-s4').status, refine: op(P2, 'refine').children(s4)[0].spec.base, add: op(P2, 'add:' + A3).children(s4)[0].spec.base },
}
let dry = await P2.rsi.explore({ dry: true, arms: 4, novelty: 0 })
res.dry = { items: (dry.items || []).map((x) => ({ base: x.spec ? x.spec.base : null, exists: x.spec && x.spec.base ? P2.rsi.store.hasNode(x.spec.base) : null })), nRejected: (dry.rejected || []).length }
//①重做: 做夢判 n2 重做
mode.rework = id2
await P2.domain.hooks.afterRound({ round: 2, nodes: [id1, id2, id3].map((id) => P2.rsi.store.getNode(id)) })
res.obs = obs
let d2 = P2.records.getNodeDoc(id2)
res.doc = { attempt: d2.attempt, trial: d2.task.trial, refs: d2.task.refs.filter((r) => r.nodeId).map((r) => r.nodeId), base: d2.task.base ? d2.task.base.nodeId : null }
res.dirsEnd = fs.readdirSync(wk).sort()
//對照表所選之 id 已不在樹上(節點於本程序存續中被刪除)⇒ 重建一次再取: n3 與其孿生皆為已執行之同規格者(n3 之 id 排在前 ⇒ 表內取 n3)
let rmNode = (id) => fs.rmSync(P2.rsi.store.fpNode(id), { force: true })
let b0 = op(P2, 'refine').children(s3)[0].spec.base
rmNode(id3)
let b1 = op(P2, 'refine').children(s3)[0].spec.base
let b1add = op(P2, 'add:' + A1).children(s3)[0].spec.base
rmNode('zz-s3-twin')
let b2 = op(P2, 'refine').children(s3)[0].spec.base
res.rebuild = { b0, b1, b1add, b2, idNew3: P2.idOf(s3), n3Gone: !P2.rsi.store.hasNode(id3), twinGone: !P2.rsi.store.hasNode('zz-s3-twin'), twinAfterN3: 'zz-s3-twin' > id3 }
console.log('RESULT ' + JSON.stringify(res))
`, 'utf8')
        let env = { ...process.env, ARSI_ROOT: root }
        for (let k of ['ARSI_HARNESS', 'ARSI_LEDGER_DIR', 'ARSI_EVAL_FROM']) {
            delete env[k]
        }
        let rc = spawnSync(process.execPath, [path.join(root, 'child.mjs')], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 540000, maxBuffer: 64 * 1024 * 1024 })
        let line = `${rc.stdout}`.split(/\r?\n/).find((l) => l.startsWith('RESULT '))
        assert(line, `${rc.stdout}\n${rc.stderr}`.slice(-3000))
        let res = JSON.parse(line.slice(7))
        let { id1, id2, id3 } = res.ids
        //③鍵未變
        assert.deepStrictEqual(res.same, { task: true, trial: { id: 'T1', variant: 'B' }, selfInRefs: false, refine: true, add: true, hyp: true })
        //鑑別前提: 鍵改變、舊節點經全樹重算保留其 id 而現行之 idOf 不同
        assert.notEqual(res.env1, res.env0)
        assert(res.rv0.every((r) => r.ok) && res.rv1.every((r) => r.ok), JSON.stringify([res.rv0, res.rv1]))
        assert.deepStrictEqual(res.idsAfter, [id1, id2, id3].sort())
        assert(res.idNew.id1 !== id1 && res.idNew.id2 !== id2)
        //全樹重算(驗證之 refsOf)不另建以新 id 為名之工作夾
        assert.deepStrictEqual(res.dirsAfterReverify, [id1, id2, id3].sort())
        //②展開: 起點 = 父節點於樹上之 id(存在、閘門通過; 同規格之非已執行之存根不取); 假設之規格(不在樹上)= idOf
        assert(id1 > '0stub-same-spec', '存根之 id 排在已執行者之前(同級依 id 時會取存根 —— 鑑別前提)')
        assert.equal(res.expand.refine.base, id2)
        assert.equal(res.expand.refine.exists, true)
        assert.deepStrictEqual(res.expand.refine.gate, { ok: true })
        assert(res.expand.refine.reason.includes(id2.slice(0, 8)), res.expand.refine.reason)
        assert.equal(res.expand.add.base, id1)
        assert.deepStrictEqual(res.expand.add.gate, { ok: true })
        assert(res.expand.add.reason.includes(id1.slice(0, 8)), res.expand.add.reason)
        assert.equal(res.expand.hyp, true)
        //快速路徑命中之節點非已執行而同規格另有已執行者 ⇒ 取已執行者(鑑別前提:命中者確為現行 id、非已執行、與 n1 不同,n1 為已執行;上列 add.base = n1 即其結果)
        assert.deepStrictEqual(res.expand.stub, { id: res.idNew.id1, exists: true, status: 'rejectedByGate', n1Status: 'executed' })
        assert.notEqual(res.expand.stub.id, id1)
        //快速路徑命中之節點非已執行而同規格無已執行者(另有一個 id 排在前之非已執行之舊節點)⇒ 仍為命中之節點
        assert(res.expand.noExec.id > '-old-s4', '舊之非已執行者之 id 排在命中者之前(同級依 id 時會取之 —— 鑑別前提)')
        assert.equal(res.expand.noExec.idStatus, 'rejectedByGate')
        assert.equal(res.expand.noExec.oldStatus, 'rejectedByGate')
        assert.equal(res.expand.noExec.refine, res.expand.noExec.id)
        assert.equal(res.expand.noExec.add, res.expand.noExec.id)
        //對照表所選之 id 已不在樹上 ⇒ 重建一次再取(刪除前取表內之 n3;刪除後取其孿生;皆無 ⇒ idOf)
        assert(res.rebuild.twinAfterN3, '孿生之 id 排在 n3 之後(刪除前表內取 n3 —— 鑑別前提)')
        assert.equal(res.rebuild.b0, id3)
        assert(res.rebuild.n3Gone && res.rebuild.twinGone, '節點檔確已刪除')
        assert.equal(res.rebuild.b1, 'zz-s3-twin')
        assert.equal(res.rebuild.b1add, 'zz-s3-twin')
        assert.equal(res.rebuild.b2, res.rebuild.idNew3)
        assert.notEqual(res.rebuild.idNew3, id3)
        //引擎之乾跑: 自舊節點展開之計畫項之起點皆存在、無閘門拒絕
        assert(res.dry.items.length >= 1, JSON.stringify(res.dry))
        assert(res.dry.items.every((x) => x.base === null || x.exists === true), JSON.stringify(res.dry))
        assert.equal(res.dry.nRejected, 0, JSON.stringify(res.dry))
        //①重做: 派工一次、於樹上之 id 之工作夾; 起點與參考成品之複本在其中、任務書所指者皆在其中; 無以新 id 為名之工作夾
        assert.equal(res.obs.length, 1)
        let o = res.obs[0]
        assert.equal(o.wd, id2)
        assert(o.files.includes('base_pick.mjs') && o.files.includes(`ref_${id3.slice(0, 8)}.mjs`), JSON.stringify(o.files))
        assert(o.copies.length >= 2 && o.copies.every((c) => c.startsWith(`${id2}/`)), JSON.stringify(o.copies))
        assert.deepStrictEqual(o.dirs.filter((d) => !d.startsWith('dream_')), [id1, id2, id3].sort())
        //參考清單不含自己; 起點 = 樹上之起點; 沿用節點文件所記之組別
        assert(!res.doc.refs.includes(id2), JSON.stringify(res.doc.refs))
        assert(res.doc.refs.includes(id3))
        assert.equal(res.doc.base, id1)
        assert.deepStrictEqual(res.doc.trial, { id: 'T1', variant: 'B' })
        assert.equal(res.doc.attempt, 2)
        assert.deepStrictEqual(res.dirsEnd.filter((d) => !d.startsWith('dream_')), [id1, id2, id3].sort())
    })
})
