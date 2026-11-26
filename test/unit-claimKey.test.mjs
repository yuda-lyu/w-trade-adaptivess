import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeProject, unproposedNoteOf } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp } from './tools/synthLedger.mjs'

describe('驗證類方向之主張鍵(規則 R-REC-24):同臂同起點而主張不同之驗證各為一個節點', function () {
    let t
    let st
    let P
    let arms = ['A01_nt', 'B14_pitKey']
    let k1 = '0a1b2c3d'
    let k2 = '12345678' //全為數字之鍵亦須可用
    let c1 = '主張甲:四個半庫皆成立'
    let c2 = '主張乙:不共用格點之鄰格亦成立'
    before(() => {
        t = makeTmp('claimKey')
        st = getSettings()
        let d = path.join(t.dir, 'proj')
        st.rsi.root = path.join(d, 'rsi')
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synth' }), 'utf8')
        P = makeProject(st, { dispatch: async () => ({ ok: false, error: '測試不派工' }), gate: null, catalogFile: path.join(d, 'catalog.json') })
        P.rsi.init()
        //做夢文件: 三條同臂同起點之方向 —— 驗證(主張甲)、驗證(主張乙)、探索; 入前緣時之主張鍵記於 harness.applied.proposals(與方向逐條對齊)
        P.records.putDreamDoc({
            round: 1,
            createdAt: '2026-11-14T00:00:00.000Z',
            agent: { model: 'm', durationSec: 1 },
            scope: { nodes: [] },
            audits: [],
            synthesis: { summary: 's', worked: [], failed: [], patterns: [] },
            guidance: {
                directions: [
                    { type: 'verify', arms, base: null, claim: c1, rationale: 'r1', expect: 'e1' },
                    { type: 'verify', arms, base: null, claim: c2, rationale: 'r2', expect: 'e2' },
                    { type: 'explore', arms, base: null, rationale: 'r3', expect: 'e3' },
                ],
                avoid: [],
                openQuestions: [],
                improvements: []
            },
            docsUpdated: [],
            harness: { applied: { accepted: [], rework: [], deleted: [], proposals: [{ arms, base: null, ok: true, claimKey: k1 }, { arms, base: null, ok: true, claimKey: k2 }, { arms, base: null, ok: true }], skipped: [] } },
        })
    })
    after(() => {
        t.cleanup()
    })

    it('規格:claim 為選配之 8 個十六進位字;帶鍵與不帶鍵之規格其節點 id 各不相同;既有形式(臂 + 起點)之 id 不因本規則而變', () => {
        let s0 = { arms, base: null }
        P.domain.validateSpec(s0)
        P.domain.validateSpec({ ...s0, claim: k1 })
        for (let bad of ['xyz', '0A1B2C3D', '0a1b2c3', 12345678, null]) {
            assert.throws(() => P.domain.validateSpec({ ...s0, claim: bad }), /spec\.claim/, `應拒收 ${JSON.stringify(bad)}`)
        }
        let ids = [P.idOf(s0), P.idOf({ ...s0, claim: k1 }), P.idOf({ ...s0, claim: k2 })]
        assert.equal(new Set(ids).size, 3)
        assert.equal(P.idOf({ arms, base: null }), ids[0], '同一規格之 id 穩定')
    })

    it('節點之來源方向:臂、起點、主張鍵三者皆相同者才對應 —— 兩條驗證各得自己之主張;不帶鍵之規格對到探索類之方向(不對到帶鍵之驗證)', () => {
        let s0 = { arms, base: null }
        assert.equal(P.typeOf({ ...s0, claim: k1 }), 'verify')
        assert.equal(P.typeOf({ ...s0, claim: k2 }), 'verify')
        assert.equal(P.typeOf(s0), 'explore')
        assert.equal(P.typeOf({ ...s0, claim: 'ffffffff' }), 'explore', '無對應之方向 ⇒ 探索(與非做夢所提之規格同)')
        let t1 = P.taskFor({ ...s0, claim: k1 }, 2)
        let t2 = P.taskFor({ ...s0, claim: k2 }, 2)
        let t0 = P.taskFor(s0, 2)
        assert.deepEqual([t1.type, t1.claim, t1.direction.rationale], ['verify', c1, 'r1'])
        assert.deepEqual([t2.type, t2.claim, t2.direction.rationale], ['verify', c2, 'r2'])
        assert.deepStrictEqual([t0.type, t0.claim, t0.direction.rationale], ['explore', null, 'r3'])
    })

    it('方向入前緣之去重:驗證類含主張 —— 同臂同起點而主張不同者皆入前緣且規格各異;主張相同者略過;探索類維持「臂 + 起點」;鍵隨回傳值記錄', () => {
        //驗收: 兩條臂與起點相同、主張不同之驗證方向皆入前緣; 主張相同者仍略過
        let a3 = ['A01_nt', 'B17_rollingKeys']
        let v = (claim) => ({ type: 'verify', arms: a3, base: null, claim, rationale: 'r' })
        let r1 = P.proposeDirection(v('主張一'), 5)
        let r2 = P.proposeDirection(v('主張二'), 5)
        let r3 = P.proposeDirection(v('  主張一  '), 5)
        let rx = P.proposeDirection({ type: 'explore', arms: a3, base: null, rationale: 'r' }, 5)
        let rx2 = P.proposeDirection({ arms: a3, base: null, rationale: 'r' }, 5)
        assert.deepEqual([r1.ok, r1.note, r2.ok, r2.note], [true, '已入前緣', true, '已入前緣'])
        assert(/^[0-9a-f]{8}$/.test(r1.claimKey) && /^[0-9a-f]{8}$/.test(r2.claimKey) && r1.claimKey !== r2.claimKey && r1.nodeId !== r2.nodeId)
        assert.deepEqual([r3.ok, r3.note, r3.claimKey, r3.nodeId], [false, '前緣已有同規格', r1.claimKey, r1.nodeId], '主張相同(頭尾空白不計)⇒ 同規格而略過')
        assert.deepStrictEqual([rx.ok, rx.note, rx.claimKey], [true, '已入前緣', undefined], '探索類不帶鍵, 與同臂同起點之驗證並存')
        assert.deepEqual([rx2.ok, rx2.note], [false, '前緣已有同規格'], '探索類仍以臂 + 起點去重')
        let specs = P.rsi.store.listFrontier().filter((f) => f.status === 'proposed' && f.spec.arms.join('+') === a3.join('+')).map((f) => f.spec.claim || null).sort()
        assert.deepStrictEqual(specs, [null, r1.claimKey, r2.claimKey].sort())
        //驗證類而無主張者(不合任務書, 但規格容許)不帶鍵
        assert.strictEqual(P.proposeDirection({ type: 'verify', arms: ['A01_nt', 'B16_perTradeQuality'], base: null, claim: '  ', rationale: 'r' }, 5).claimKey, undefined)
        assert.equal(P.closeFrontier({ arms: a3, why: '測試收尾' }), 3)
        //已結案之同規格提案(改掛後之舊項、主控結案)不擋其後之同規格方向: 重開而非當成重複(例: 暫掛之寬臂組合與上一輪改掛掉之舊項同規格)
        let again = P.proposeDirection({ type: 'explore', arms: a3, base: null, rationale: '再提' }, 6)
        assert.deepEqual([again.ok, again.note], [true, '已入前緣(重開先前已結案之同規格提案)'])
        assert.equal(P.rsi.store.listFrontier().filter((f) => f.status === 'proposed' && f.spec.arms.join('+') === a3.join('+') && !f.spec.claim).length, 1)
        assert.deepEqual([P.proposeDirection({ type: 'explore', arms: a3, base: null, rationale: '三提' }, 6).note], ['前緣已有同規格'], '尚未結案者仍為重複')
        assert.equal(P.closeFrontier({ arms: a3, why: '測試收尾 2' }), 1)
        assert.equal(P.closeFrontier({ arms: ['A01_nt', 'B16_perTradeQuality'], why: '測試收尾' }), 1)
    })

    it('探索類方向與既有節點同臂同起點(Gitea #154):規格另帶區分用之鍵後入前緣(不靜默略過);依據相同者才略過;未相撞者規格不變;節點對到該探索方向', () => {
        //驗收: 對既有節點之臂與起點提一條探索類方向 ⇒ 入前緣且規格帶鍵; 依據文字相同者再提 ⇒ 略過; 未與節點相撞者不帶鍵
        let a4 = ['A01_nt', 'B15_newKey']
        let s0 = { arms: a4, base: null }
        let id0 = P.idOf(s0)
        let putExecuted = (spec, round) => P.rsi.store.putNode({ id: P.idOf(spec), spec, specHash: specHash(spec), status: 'executed', parents: [], round })
        //樹上先有同規格之已執行節點
        putExecuted(s0, 3)
        assert.equal(P.rsi.store.getNode(id0).status, 'executed')
        let r1 = P.proposeDirection({ type: 'explore', arms: a4, base: null, rationale: '機制甲:另一種量' }, 7)
        assert(r1.ok === true && /^[0-9a-f]{8}$/.test(r1.claimKey) && r1.nodeId !== id0, JSON.stringify(r1))
        assert(r1.note.startsWith('已入前緣') && r1.note.includes(id0.slice(0, 8)) && r1.note.includes('區分用之鍵'), r1.note)
        let f1 = P.rsi.store.listFrontier().find((f) => f.status === 'proposed' && f.spec.arms.join('+') === a4.join('+'))
        assert(f1 && f1.spec.claim === r1.claimKey && P.idOf(f1.spec) === r1.nodeId, '前緣之規格帶該鍵')
        //依據文字相同(頭尾空白不計)之重提 ⇒ 同鍵同規格而略過(前緣已有); 依據不同者為另一個鍵、另一個節點
        let r2 = P.proposeDirection({ type: 'explore', arms: a4, base: null, rationale: '  機制甲:另一種量  ' }, 8)
        assert.deepEqual([r2.ok, r2.note, r2.claimKey], [false, '前緣已有同規格', r1.claimKey])
        let r3 = P.proposeDirection({ arms: a4, base: null, rationale: '機制乙' }, 8)
        assert(r3.ok === true && r3.claimKey !== r1.claimKey && r3.nodeId !== r1.nodeId, '未標類型者視同探索;依據不同 ⇒ 另一個鍵')
        //帶鍵之提案已結案(改掛後之舊項、主控結案)而樹上無此節點 ⇒ 重開(註明帶鍵); 該鍵之規格已有節點(依據相同之探索已執行)⇒ 略過
        assert.equal(P.closeFrontier({ arms: a4, claim: r1.claimKey, why: '測試結案' }), 1)
        let r1b = P.proposeDirection({ type: 'explore', arms: a4, base: null, rationale: '機制甲:另一種量' }, 9)
        assert(r1b.ok === true && r1b.claimKey === r1.claimKey && r1b.note.startsWith('已入前緣(重開先前已結案之同規格提案)') && r1b.note.includes('區分用之鍵'), JSON.stringify(r1b))
        putExecuted(f1.spec, 9)
        let r1c = P.proposeDirection({ type: 'explore', arms: a4, base: null, rationale: '機制甲:另一種量' }, 10)
        assert(r1c.ok === false && r1c.claimKey === r1.claimKey && r1c.nodeId === r1.nodeId && r1c.note.includes('依據相同之探索') && r1c.note.includes(r1.nodeId.slice(0, 8)), JSON.stringify(r1c))
        //無依據文字者無從產生鍵 ⇒ 照舊回「同規格之節點已存在」
        let r4 = P.proposeDirection({ type: 'explore', arms: a4, base: null, rationale: '   ' }, 8)
        assert.deepStrictEqual([r4.ok, r4.claimKey], [false, undefined])
        assert(r4.note.includes('同規格之節點已存在') && r4.note.includes(id0.slice(0, 8)), r4.note)
        //驗證類不走此路(有主張者以主張鍵區分; 無主張而相撞者照舊略過)
        let r5 = P.proposeDirection({ type: 'verify', arms: a4, base: null, claim: ' ', rationale: '驗證而無主張' }, 8)
        assert(r5.ok === false && r5.claimKey === undefined && r5.note.includes('同規格之節點已存在'), JSON.stringify(r5))
        //未與既有節點相撞之探索: 規格不帶鍵(既有形式不變)
        let a5 = ['A01_nt', 'B16_perTradeQuality', 'C23_recent365']
        let r6 = P.proposeDirection({ type: 'explore', arms: a5, base: null, rationale: '未相撞' }, 8)
        assert.deepStrictEqual([r6.ok, r6.note, r6.claimKey], [true, '已入前緣', undefined])
        assert(P.rsi.store.listFrontier().filter((f) => f.status === 'proposed' && f.spec.arms.join('+') === a5.join('+')).every((f) => f.spec.claim === undefined), '未相撞者之規格不帶鍵')
        //帶鍵之規格: 來源方向以 harness.applied.proposals 之 claimKey 對應 ⇒ 類型為探索、無主張; 不帶鍵之同臂規格(既有節點)不對到它
        P.records.putDreamDoc({
            round: 7,
            createdAt: '2026-11-15T00:00:00.000Z',
            agent: { model: 'm', durationSec: 1 },
            scope: { nodes: [] },
            audits: [],
            synthesis: { summary: 's', worked: [], failed: [], patterns: [] },
            guidance: { directions: [{ type: 'explore', arms: a4, base: null, rationale: '機制甲:另一種量', expect: 'e7' }], avoid: [], openQuestions: [], improvements: [] },
            docsUpdated: [],
            harness: { applied: { accepted: [], rework: [], deleted: [], proposals: [{ arms: a4, base: null, ...r1 }], skipped: [] } },
        })
        let tk = P.taskFor(f1.spec, 8)
        assert.deepStrictEqual([tk.type, tk.claim, tk.direction.rationale, tk.direction.round, tk.direction.claimKey], ['explore', null, '機制甲:另一種量', 7, r1.claimKey])
        assert.equal(P.typeOf(f1.spec), 'explore')
        assert(!P.taskFor(s0, 8).direction, '不帶鍵之既有節點之規格不對到帶鍵之方向')
        assert.equal(P.closeFrontier({ arms: a4, why: '測試收尾' }), 2)
        assert.equal(P.closeFrontier({ arms: a5, why: '測試收尾' }), 1)
    })

    it('已執行之探索逐字重提不再跑一次;帶鍵之節點(改掛後)之同一依據重提亦略過;前緣內之同規格已非待執行者註明其狀態(Gitea #154 外審之補格)', () => {
        let a6 = ['A01_nt', 'B14_pitKey', 'C23_recent365']
        let a7 = ['A01_nt', 'B15_newKey', 'C23_recent365']
        let putExecuted = (spec, round) => P.rsi.store.putNode({ id: P.idOf(spec), spec, specHash: specHash(spec), status: 'executed', parents: [], round })
        let putDoc = (id, rationale) => {
            //節點文件所記之來源方向(arsi.runNode 寫入之 task.direction); 只寫本案用到之欄位
            fs.mkdirSync(path.dirname(P.records.paths.nodeJson(id)), { recursive: true })
            fs.writeFileSync(P.records.paths.nodeJson(id), JSON.stringify({ nodeId: id, task: { direction: { rationale } } }), 'utf8')
        }
        //(1) 既有節點(不帶鍵之規格)即出自同一依據(頭尾空白不計)⇒ 同一探索之重提, 略過且不帶鍵; 出自他處(依據不同、或無來源方向)⇒ 另帶鍵
        let s6 = { arms: a6, base: null }
        putExecuted(s6, 3)
        putDoc(P.idOf(s6), '  已執行之探索  ')
        let q1 = P.proposeDirection({ type: 'explore', arms: a6, base: null, rationale: '已執行之探索' }, 8)
        assert(q1.ok === false && q1.claimKey === undefined && q1.nodeId === P.idOf(s6) && q1.note.includes('依據相同之探索'), JSON.stringify(q1))
        let q2 = P.proposeDirection({ type: 'explore', arms: a6, base: null, rationale: '另一種機制' }, 8)
        assert(q2.ok === true && /^[0-9a-f]{8}$/.test(q2.claimKey), JSON.stringify(q2))
        //(2) 帶鍵之節點已執行(同一依據之鍵與臂組合無關; 例: 帶鍵之方向改掛到另一臂組合後執行)而該臂組合之不帶鍵之規格未被占用 ⇒ 同一依據重提仍略過(不得另產生不帶鍵之節點); 依據不同者照常不帶鍵入前緣
        let mk = q2.claimKey
        putExecuted({ arms: a7, base: null, claim: mk }, 4)
        assert.strictEqual(P.rsi.store.getNode(P.idOf({ arms: a7, base: null })), null, '前置: 不帶鍵之規格未被占用')
        let q3 = P.proposeDirection({ type: 'explore', arms: a7, base: null, rationale: '另一種機制' }, 9)
        assert(q3.ok === false && q3.claimKey === mk && q3.nodeId === P.idOf({ arms: a7, base: null, claim: mk }) && q3.note.includes('依據相同之探索'), JSON.stringify(q3))
        let q4 = P.proposeDirection({ type: 'explore', arms: a7, base: null, rationale: '再一種機制' }, 9)
        assert.deepStrictEqual([q4.ok, q4.note, q4.claimKey], [true, '已入前緣', undefined], '依據不同 ⇒ 不帶鍵入前緣')
        //同臂組合之既有節點為帶鍵者之重提: 同一依據 ⇒ 略過
        putExecuted({ ...s6, claim: mk }, 5)
        let q5 = P.proposeDirection({ type: 'explore', arms: a6, base: null, rationale: '另一種機制' }, 11)
        assert(q5.ok === false && q5.claimKey === mk && q5.note.includes('依據相同之探索'), JSON.stringify(q5))
        //(3) 前緣內之同規格已非待執行(例: 規格不過閘而標 rejectedByGate)⇒ 略過並註明該項不會執行; 待執行者之字樣不變
        let a8 = ['A01_nt', 'B17_rollingKeys', 'C23_recent365']
        let w1 = P.proposeDirection({ type: 'explore', arms: a8, base: null, rationale: 'w' }, 12)
        assert.deepEqual([w1.ok, w1.note], [true, '已入前緣'])
        assert.equal(P.proposeDirection({ type: 'explore', arms: a8, base: null, rationale: 'w' }, 12).note, '前緣已有同規格')
        P.rsi.store.markFrontier([specHash({ arms: a8, base: null })], 'rejectedByGate')
        let w2 = P.proposeDirection({ type: 'explore', arms: a8, base: null, rationale: 'w2' }, 13)
        assert(w2.ok === false && w2.note === '前緣已有同規格(該項狀態 rejectedByGate,不會執行)', JSON.stringify(w2))
        //收尾: 前緣內本案入列之待執行者結案
        assert.equal(P.closeFrontier({ arms: a6, why: '測試收尾' }), 1)
        assert.equal(P.closeFrontier({ arms: a7, why: '測試收尾' }), 1)
    })

    it('輪末摘要「方向未入前緣」各行(Gitea #154;純函數 unproposedNoteOf):全數入前緣 ⇒ 空陣列;否則首行列筆數,其後一條一行(序號、臂、起點、原因)', () => {
        let a4 = ['A01_nt', 'B15_newKey']
        assert.deepEqual(unproposedNoteOf([]), [])
        assert.deepEqual(unproposedNoteOf(undefined), [])
        assert.deepEqual(unproposedNoteOf([{ arms: a4, base: null, ok: true, note: '已入前緣' }]), [])
        let s = unproposedNoteOf([{ arms: a4, base: null, ok: true, note: '已入前緣' }, { arms: a4, base: 'abcdef0123456789', ok: false, note: '前緣已有同規格' }, { arms: ['X09_none'], base: null, ok: false, note: 'x'.repeat(200) }, { ok: false }])
        assert.equal(s.length, 4, '首行 + 三條未入者各一行')
        assert(s[0].startsWith('**方向未入前緣 3 條**') && !s[0].includes('由前緣內既有之提案執行'), s[0])
        assert.equal(s[1], '方向未入前緣:方向 2(A01_nt + B15_newKey;起點 abcdef01):前緣已有同規格')
        assert.equal(s[2], `方向未入前緣:方向 3(X09_none;起點 無):${'x'.repeat(160)}`, '原因取前 160 字; 起點為空者寫「起點 無」')
        assert(s[3].startsWith('方向未入前緣:方向 4(') && !s.some((l) => l.includes('方向 1(')), '序號自 1 起、對應做夢文件內方向之位置; 已入前緣者不列')
        assert(s.every((l) => l.length < 400), '每行不逾一頁摘要之截斷長度(roundDigest 每行取前 400 字)')
    })

    it('舊文件(入前緣時無主張鍵之驗證類方向)照舊以臂與起點對應', () => {
        let arms2 = ['A01_nt', 'B16_perTradeQuality']
        P.records.putDreamDoc({
            round: 2,
            createdAt: '2026-11-14T01:00:00.000Z',
            agent: { model: 'm', durationSec: 1 },
            scope: { nodes: [] },
            audits: [],
            synthesis: { summary: 's', worked: [], failed: [], patterns: [] },
            guidance: { directions: [{ type: 'verify', arms: arms2, base: null, claim: '舊主張', rationale: 'old', expect: 'e' }], avoid: [], openQuestions: [], improvements: [] },
            docsUpdated: [],
            harness: { applied: { accepted: [], rework: [], deleted: [], proposals: [{ arms: arms2, base: null, ok: true, note: '已入前緣' }], skipped: [] } },
        })
        let tk = P.taskFor({ arms: arms2, base: null }, 3)
        assert.deepEqual([tk.type, tk.claim], ['verify', '舊主張'])
    })

    it('前緣改掛(R-ARM-4):同臂同起點有數條時須以主張鍵指明(訊息列出各鍵);新規格承接主張鍵,來源方向仍對得上', () => {
        let push = (claim) => {
            let spec = { arms, base: null, claim }; P.rsi.store.pushFrontier([{ spec, specHash: specHash(spec), kind: 'arm', reason: `r ${claim}`, origin: { topic: 'dream', operator: 'dream', round: 1 }, priority: 1 }])
        }
        push(k1)
        push(k2)
        let to = ['A02_ntPit', 'B14_pitKey']
        let amb = P.rearmFrontier({ arms, to, why: '測試' })
        assert(amb.ok === false && amb.why.includes(k1) && amb.why.includes(k2), JSON.stringify(amb))
        let r = P.rearmFrontier({ arms, to, claim: k2, why: '測試' })
        assert(r.ok === true && r.round === 1, JSON.stringify(r))
        let fr = P.rsi.store.listFrontier()
        assert(fr.some((f) => f.status === 'proposed' && f.spec.arms.join('+') === to.join('+') && f.spec.claim === k2), '新提案承接主張鍵')
        assert(fr.some((f) => f.status === 'blocked' && f.spec.arms.join('+') === arms.join('+') && f.spec.claim === k2) && fr.some((f) => f.status === 'proposed' && f.spec.claim === k1), '只結案被指明之一條')
        let tk = P.taskFor({ arms: to, base: null, claim: k2 }, 2)
        assert.deepEqual([tk.type, tk.claim], ['verify', c2], '改掛後之規格仍對到主張乙之方向')
        assert.equal(P.taskFor({ arms, base: null, claim: k1 }, 2).claim, c1, '未改掛之一條不受影響')
        assert.equal(P.closeFrontier({ arms, claim: k1, why: '測試' }), 1)
    })
})
