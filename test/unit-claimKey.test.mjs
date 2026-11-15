import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
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
        assert.deepEqual([t0.type, t0.claim, t0.direction.rationale], ['explore', null, 'r3'])
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
        assert.deepEqual([rx.ok, rx.note, rx.claimKey], [true, '已入前緣', undefined], '探索類不帶鍵, 與同臂同起點之驗證並存')
        assert.deepEqual([rx2.ok, rx2.note], [false, '前緣已有同規格'], '探索類仍以臂 + 起點去重')
        let specs = P.rsi.store.listFrontier().filter((f) => f.status === 'proposed' && f.spec.arms.join('+') === a3.join('+')).map((f) => f.spec.claim || null).sort()
        assert.deepEqual(specs, [null, r1.claimKey, r2.claimKey].sort())
        //驗證類而無主張者(不合任務書, 但規格容許)不帶鍵
        assert.equal(P.proposeDirection({ type: 'verify', arms: ['A01_nt', 'B16_perTradeQuality'], base: null, claim: '  ', rationale: 'r' }, 5).claimKey, undefined)
        assert.equal(P.closeFrontier({ arms: a3, why: '測試收尾' }), 3)
        //已結案之同規格提案(改掛後之舊項、主控結案)不擋其後之同規格方向: 重開而非當成重複(例: 暫掛之寬臂組合與上一輪改掛掉之舊項同規格)
        let again = P.proposeDirection({ type: 'explore', arms: a3, base: null, rationale: '再提' }, 6)
        assert.deepEqual([again.ok, again.note], [true, '已入前緣(重開先前已結案之同規格提案)'])
        assert.equal(P.rsi.store.listFrontier().filter((f) => f.status === 'proposed' && f.spec.arms.join('+') === a3.join('+') && !f.spec.claim).length, 1)
        assert.deepEqual([P.proposeDirection({ type: 'explore', arms: a3, base: null, rationale: '三提' }, 6).note], ['前緣已有同規格'], '尚未結案者仍為重複')
        assert.equal(P.closeFrontier({ arms: a3, why: '測試收尾 2' }), 1)
        assert.equal(P.closeFrontier({ arms: ['A01_nt', 'B16_perTradeQuality'], why: '測試收尾' }), 1)
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
