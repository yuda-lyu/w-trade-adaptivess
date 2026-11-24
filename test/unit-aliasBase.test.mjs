import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeProject, rankKeyOf, rebasedNoteOf } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//起點為別名(選集指紋與較早之節點相同之節點)時之一致處理(規則 R-REC-45)
//  規格: ①補位之底(carrierBase)不取別名: 排序鍵最高者為別名時取其正本(正本不合底之條件者取其次); 其餘條件(可信、未被否決、臂數未滿、排序鍵、同鍵依 id)不變
//    ②方向之起點為別名者(proposeDirection): 改以其正本為起點入前緣, note 註明改掛、回傳另帶 baseUsed; 節點之來源方向依 baseUsed 對應; 做夢文件加一則迴圈註記; 輪末摘要列一段
//    ③前置閘門(gates.pre): 起點為別名而仍到達閘門者仍拒, 訊息明示其正本; 起點確實不存在或未執行者之訊息逐字不變
//    ④未觸發(樹上無別名、起點非別名)者之輸出逐字不變; 別名表取不到(引擎無此函數、拋錯、非 Map)⇒ 視同無別名, 不使出計畫、做夢之套用中斷
//  接縫不用替身: 真 w-recursi 之樹(別名表為引擎之 rsi.aliasMap)+ 本套件真實之領域(makeProject 之 domain.carriers、domain.gates.pre、proposeDirection、taskFor、hooks.afterRound)
//  合成資料: 各節點之臂、輪次、S、選集指紋逐筆相異; 別名與正本之 id 大小依 idOf 之實際結果安排(測試內先斷言前提)
describe('起點為別名(選集與較早之節點相同)時之一致處理(規則 R-REC-45)', function () {
    this.timeout(120000)

    let t
    beforeEach(() => {
        t = makeTmp('aliasBase')
    })
    afterEach(() => {
        t.cleanup()
    })

    //mk, 暫存夾之專案(假派工; 做夢依 dream.template.json 交付 dreamDirs 所給之方向)
    let mk = ({ dreamDirs = null } = {}) => {
        let st = getSettings()
        let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
        st.resources = {}
        //docLimits: false —— 輪末鉤子之專案文件自動整理(R-REC-17)取本庫自身之 sgud(FD_ROOT 為模組常數), 測試不得改寫入版控之文件(R-PKG-10)
        //maxArmsPerNode: 4 —— 「臂數已滿」之子案以 4 個臂為滿; 明設而不取設定檔之值(設定檔可調, 重產於他處執行時值可不同)
        st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), docLimits: false, maxArmsPerNode: 4 }
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthAlias' }), 'utf8')
        let calls = { dream: 0 }
        let dispatch = async (role, { prompt }) => {
            if (role !== 'dream' || !dreamDirs) {
                throw new Error('fake: 不派工')
            }
            calls.dream++
            let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
            let wd = path.resolve(st.FD_ROOT, m[1])
            let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
            let dream = {
                audits: tpl.audits.map((a) => ({ nodeId: a.nodeId, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [] })),
                synthesis: { summary: '假做夢', worked: [], failed: [], patterns: [], prevDirections: [] },
                guidance: { directions: dreamDirs(), avoid: [], openQuestions: [], improvements: [], armProposals: [] },
                expansion: [],
                docsUpdated: [],
            }
            fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
            return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
        }
        let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json') })
        P.rsi.init()
        return { P, st, calls }
    }
    //put, 把一個已執行之節點入樹: sel = 選集指紋(raw.selHash; 同值者為別名與其正本之關係, 輪次較早者為正本); reps = 重放之 S(影響排序鍵)
    let put = (P, { arms, base = null, round, S, sel, trust = 'trusted', vetoed = false, reps = null, k }) => {
        let spec = { arms, base }
        let id = P.idOf(spec)
        let metrics = {
            op: { eqYr: { mean: 20 + k * 1.1, min: -3 - k * 0.7, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v * k) }, monthlyOrders: { mean: 90 + k }, peakHold: { max: 25 + k } },
            null: { mean: -5 - k, excess: 10 + k, z: 2 + k / 10, p: 0.001 * k },
            nullSideAct: { excess: 8.7 + k, p: 0.02 + k / 1000, share: 0.3 + k / 100, mean: 4 + k, half: 50, triggered: true },
            ext: {},
        }
        let raw = { selHash: sel, metrics, issues: [], ...(reps ? { seedS: reps.slice(), replays: reps.map((s, i) => ({ S: s, comp: 3.5 + k + i, recent: null })) } : {}) }
        P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round, raw, score: { S, ladder: 1, flags: { vetoed, why: [] } }, evidence: { trust } })
        return id
    }
    //pair, 兩個臂不同之單臂規格依 idOf 之大小分為 [小 id 者, 大 id 者](別名與正本之 id 大小由此安排)
    let pairOf = (P, a1, a2) => {
        let s1 = { arms: [a1], base: null }
        let s2 = { arms: [a2], base: null }
        return P.idOf(s1) < P.idOf(s2) ? [a1, a2] : [a2, a1]
    }
    //viewOf, 引擎交給前置閘門之視圖: 去掉別名者(explore.mjs 之 nodesView)
    let viewOf = (P) => ({ round: 99, nodes: P.rsi.view.policyView().filter((n) => !n.aliasOf), frontier: [] })
    let CARRIER_ARMS = ['D30_volumeCut', 'E39_skipWeekend']
    //簡寫: 某臂之補位載體之規格
    let carrierOf = (P, armId) => P.domain.carriers()[armId]

    describe('甲、補位之底不取別名', function () {
        it('排序鍵最高者為別名(複本之 id 較小、輪次較晚)⇒ 載體之起點為其正本;載體經前置閘門(去掉別名之視圖)通過', () => {
            let { P } = mk()
            let [aliasArm, canonArm] = pairOf(P, 'A01_nt', 'A02_ntPit')
            let canon = put(P, { arms: [canonArm], round: 1, S: 60.31, sel: 'sel-canon', k: 1 })
            let alias = put(P, { arms: [aliasArm], round: 2, S: 60.31, sel: 'sel-canon', k: 2 })
            let other = put(P, { arms: ['A04_act'], round: 2, S: 41.27, sel: 'sel-other', k: 3 })
            //前提: 別名之 id 小於正本(同鍵時依 id 先取小者 = 別名); 引擎判別名者即此一個
            assert(alias < canon, '前提: 別名之 id 小於正本')
            assert.deepEqual([...P.rsi.aliasMap()], [[alias, canon]])
            for (let armId of CARRIER_ARMS) {
                let c = carrierOf(P, armId)
                assert.equal(c.base, canon, `${armId} 之底須為正本、不是別名`)
                assert.deepEqual(c.arms, [canonArm, armId].sort())
                let g = P.domain.gates.pre(c, { view: viewOf(P) })
                assert.deepEqual(g, { ok: true }, `${armId} 之載體須通過前置閘門: ${JSON.stringify(g)}`)
            }
            assert.notEqual(other, canon)
        })

        it('排序鍵最高者本身即正本(別名之 id 較大)⇒ 與改前相同(底為該正本)', () => {
            let { P } = mk()
            let [canonArm, aliasArm] = pairOf(P, 'A01_nt', 'A02_ntPit')
            let canon = put(P, { arms: [canonArm], round: 1, S: 58.44, sel: 'sel-c', k: 1 })
            let alias = put(P, { arms: [aliasArm], round: 2, S: 58.44, sel: 'sel-c', k: 2 })
            put(P, { arms: ['A04_act'], round: 2, S: 40.12, sel: 'sel-o', k: 3 })
            assert(canon < alias, '前提: 正本之 id 小於別名')
            assert.deepEqual([...P.rsi.aliasMap()], [[alias, canon]])
            assert.equal(carrierOf(P, 'D30_volumeCut').base, canon)
        })

        it('別名之排序鍵高於正本(重放之 S 不同)⇒ 仍取正本(別名之 id 大小與鍵之高低各自獨立)', () => {
            let { P } = mk()
            let [aliasArm, canonArm] = pairOf(P, 'A01_nt', 'A02_ntPit')
            let canon = put(P, { arms: [canonArm], round: 1, S: 52.1, sel: 'sel-c', reps: [51.3, 50.7], k: 1 })
            let alias = put(P, { arms: [aliasArm], round: 2, S: 52.1, sel: 'sel-c', reps: [66.2, 64.9], k: 2 })
            let other = put(P, { arms: ['A04_act'], round: 2, S: 44.9, sel: 'sel-o', k: 3 })
            //前提: 別名之排序鍵高於正本與另一節點(改前會取別名)
            let key = (id) => rankKeyOf(P.rsi.store.getNode(id))
            assert(key(alias) > key(canon) && key(canon) > key(other), `${key(alias)} ${key(canon)} ${key(other)}`)
            assert.equal(carrierOf(P, 'D30_volumeCut').base, canon)
        })

        it('正本不合底之條件(未審 / 被否決 / 臂數已滿)而別名合 ⇒ 別名不取,取其次之非別名者;無其他可取者 ⇒ 照舊為單臂根節點(冷啟動之形)', () => {
            for (let bad of [{ trust: null }, { vetoed: true }, { arms: ['A01_nt', 'B14_pitKey', 'C23_recent365', 'C19_jaccard'] }]) {
                let { P } = mk()
                let aliasArm = 'A02_ntPit'
                //正本 = 輪次較早者; 其條件不合
                let canon = put(P, { arms: bad.arms || ['A01_nt'], round: 1, S: 63.5, sel: 'sel-c', trust: bad.trust === undefined ? 'trusted' : bad.trust, vetoed: !!bad.vetoed, k: 1 })
                let alias = put(P, { arms: [aliasArm], round: 2, S: 63.5, sel: 'sel-c', k: 2 })
                assert.deepEqual([...P.rsi.aliasMap()], [[alias, canon]])
                let c0 = carrierOf(P, 'D30_volumeCut')
                assert.deepStrictEqual(c0, { arms: ['D30_volumeCut'], base: null }, `只有別名可信 ⇒ 無底: ${JSON.stringify(bad)}`)
                //另有一個可信之非別名節點 ⇒ 取它
                let z = put(P, { arms: ['A04_act'], round: 3, S: 37.62, sel: 'sel-z', k: 3 })
                assert.equal(carrierOf(P, 'D30_volumeCut').base, z)
                assert.deepEqual(carrierOf(P, 'D30_volumeCut').arms, ['A04_act', 'D30_volumeCut'])
            }
        })

        it('無別名之樹:底為排序鍵最高者、同鍵依 id(與改前相同之字面值);取別名表之次數 = 1 次(有候選時)、冷啟動 = 0 次', () => {
            let { P } = mk()
            let calls = 0
            let aliasMap0 = P.rsi.aliasMap
            P.rsi.aliasMap = (...a) => {
                calls++
                return aliasMap0(...a)
            }
            //冷啟動(樹上無節點): 單臂根節點、不求別名表
            assert.deepStrictEqual(carrierOf(P, 'D30_volumeCut'), { arms: ['D30_volumeCut'], base: null })
            assert.equal(calls, 0, '無候選 ⇒ 不讀樹求別名表')
            let a = put(P, { arms: ['A01_nt'], round: 1, S: 55.5, sel: 's1', k: 1 })
            put(P, { arms: ['A04_act'], round: 1, S: 49.5, sel: 's2', k: 2 })
            let b = put(P, { arms: ['A05_nKeys'], round: 2, S: 61.25, sel: 's3', k: 3 })
            assert.equal(P.rsi.aliasMap().size, 0, '前提: 無別名')
            calls = 0
            let cs = P.domain.carriers()
            assert.equal(calls, 1, '一次出計畫求值求一次別名表')
            assert.deepEqual(cs.D30_volumeCut, { arms: ['A05_nKeys', 'D30_volumeCut'], base: b })
            assert.deepEqual(cs.E39_skipWeekend, { arms: ['A05_nKeys', 'E39_skipWeekend'], base: b })
            assert.deepStrictEqual(cs.A02_ntPit, { arms: ['A02_ntPit'], base: null }, '其他層照舊為單臂根節點')
            assert.notEqual(a, b)
            //同鍵者依 id: 兩個無別名之節點同 S 時取 id 較小者
            let { P: P2 } = mk()
            let [x, y] = pairOf(P2, 'A01_nt', 'A02_ntPit')
            let ix = put(P2, { arms: [x], round: 1, S: 50.5, sel: 'u1', k: 1 })
            let iy = put(P2, { arms: [y], round: 1, S: 50.5, sel: 'u2', k: 2 })
            assert(ix < iy)
            assert.equal(carrierOf(P2, 'D30_volumeCut').base, ix)
        })

        it('別名表取不到(引擎無此函數、拋錯、非 Map)⇒ 視同無別名(取排序鍵最高者),不使出計畫中斷', () => {
            let { P } = mk()
            let [aliasArm, canonArm] = pairOf(P, 'A01_nt', 'A02_ntPit')
            let canon = put(P, { arms: [canonArm], round: 1, S: 60.31, sel: 'sel-canon', k: 1 })
            let alias = put(P, { arms: [aliasArm], round: 2, S: 60.31, sel: 'sel-canon', k: 2 })
            assert.equal(carrierOf(P, 'D30_volumeCut').base, canon)
            let aliasMap0 = P.rsi.aliasMap
            for (let [name, f] of [['拋錯', () => {
                throw new Error('fake: 別名表失敗')
            }], ['非 Map', () => ({ [alias]: canon })], ['null', () => null], ['不是函數', 'x']]) {
                P.rsi.aliasMap = f
                assert.doesNotThrow(() => P.domain.carriers(), name)
                //視同無別名: 取到排序鍵最高之別名(改前之行為)
                assert.equal(carrierOf(P, 'D30_volumeCut').base, alias, name)
            }
            delete P.rsi.aliasMap
            assert.equal(carrierOf(P, 'D30_volumeCut').base, alias, '無此函數')
            P.rsi.aliasMap = aliasMap0
            assert.equal(carrierOf(P, 'D30_volumeCut').base, canon)
        })
    })

    describe('乙、方向之起點為別名者', function () {
        //設一棵樹: 正本 canon、別名 alias(選集相同)、另一非別名者 other
        let tree = () => {
            let m = mk()
            let { P } = m
            let [aliasArm, canonArm] = pairOf(P, 'A01_nt', 'A02_ntPit')
            let canon = put(P, { arms: [canonArm], round: 1, S: 57.2, sel: 'sel-canon', k: 1 })
            let alias = put(P, { arms: [aliasArm], round: 2, S: 57.2, sel: 'sel-canon', k: 2 })
            let other = put(P, { arms: ['A04_act'], round: 2, S: 43.8, sel: 'sel-other', k: 3 })
            return { ...m, canon, alias, other, canonArm, aliasArm }
        }
        let ARMS = ['A01_nt', 'B14_pitKey']
        let frontierOf = (P, arms) => P.rsi.store.listFrontier().filter((f) => f.status === 'proposed' && f.spec.arms.join('+') === arms.join('+'))

        it('前置閘門:起點為別名 ⇒ 仍拒,訊息明示正本(字面值);起點為正本 ⇒ 通過;起點不存在 / 未執行 ⇒ 訊息與改前逐字相同', () => {
            let { P, canon, alias } = tree()
            let v = viewOf(P)
            assert(!v.nodes.some((n) => n.id === alias), '前提: 閘門之視圖不含別名')
            assert.deepEqual(P.domain.gates.pre({ arms: ARMS, base: alias }, { view: v }), { ok: false, why: `起點 ${alias.slice(0, 8)} 為 ${canon.slice(0, 8)} 之別名(選集相同);請以 ${canon.slice(0, 8)} 為起點` })
            assert.deepEqual(P.domain.gates.pre({ arms: ARMS, base: canon }, { view: v }), { ok: true })
            assert.deepEqual(P.domain.gates.pre({ arms: ARMS, base: null }, { view: v }), { ok: true })
            let ghost = 'f'.repeat(64)
            assert.deepEqual(P.domain.gates.pre({ arms: ARMS, base: ghost }, { view: v }), { ok: false, why: '起點 ffffffff 不存在或未執行' })
            //存在而未執行(視圖內有、狀態為 planned)
            let planned = { id: 'abcdef0123456789'.repeat(4), status: 'planned', spec: { arms: ['A05_nKeys'], base: null } }
            assert.deepEqual(P.domain.gates.pre({ arms: ARMS, base: planned.id }, { view: { nodes: [planned] } }), { ok: false, why: '起點 abcdef01 不存在或未執行' })
            //別名表取不到 ⇒ 改前之訊息
            let aliasMap0 = P.rsi.aliasMap
            P.rsi.aliasMap = () => {
                throw new Error('fake')
            }
            assert.deepEqual(P.domain.gates.pre({ arms: ARMS, base: alias }, { view: v }), { ok: false, why: `起點 ${alias.slice(0, 8)} 不存在或未執行` })
            P.rsi.aliasMap = aliasMap0
        })

        it('方向之起點為別名 ⇒ 改以正本入前緣:規格之起點為正本、note 與 baseUsed 之字面值;規格之 id 與以正本為起點者相同', () => {
            let { P, canon, alias } = tree()
            let r = P.proposeDirection({ type: 'explore', arms: ARMS, base: alias, rationale: '別名為起點之探索' }, 5)
            assert.deepEqual(r, { ok: true, note: `已入前緣(起點 ${alias.slice(0, 8)} 為 ${canon.slice(0, 8)} 之別名(選集相同),已改以 ${canon.slice(0, 8)} 為起點)`, nodeId: P.idOf({ arms: ARMS, base: canon }), baseUsed: canon })
            let f = frontierOf(P, ARMS)
            assert.equal(f.length, 1)
            assert.deepEqual(f[0].spec, { arms: ARMS, base: canon })
            //規格經閘門(去掉別名之視圖)通過 —— 與補位之載體同一個閘
            assert.deepEqual(P.domain.gates.pre(f[0].spec, { view: viewOf(P) }), { ok: true })
        })

        it('同一方向重提:起點寫別名與寫正本(先後各一次)不得變成兩個節點;主張鍵、區分用之鍵皆依改掛後之起點', () => {
            let { P, canon, alias } = tree()
            //(1) 先別名、後正本
            let a1 = P.proposeDirection({ type: 'explore', arms: ARMS, base: alias, rationale: '同一探索' }, 5)
            let a2 = P.proposeDirection({ type: 'explore', arms: ARMS, base: canon, rationale: '同一探索' }, 5)
            assert.deepStrictEqual([a1.ok, a2.ok, a2.note, a2.nodeId, a2.baseUsed], [true, false, '前緣已有同規格', a1.nodeId, undefined])
            assert.equal(frontierOf(P, ARMS).length, 1)
            //(2) 先正本、後別名(另一組臂)
            let arms2 = ['A01_nt', 'B15_newKey']
            let b1 = P.proposeDirection({ type: 'explore', arms: arms2, base: canon, rationale: '另一探索' }, 5)
            let b2 = P.proposeDirection({ type: 'explore', arms: arms2, base: alias, rationale: '另一探索' }, 5)
            assert.deepEqual([b1.ok, b2.ok, b2.nodeId, b2.baseUsed], [true, false, b1.nodeId, canon])
            assert.equal(b2.note, `前緣已有同規格(起點 ${alias.slice(0, 8)} 為 ${canon.slice(0, 8)} 之別名(選集相同),已改以 ${canon.slice(0, 8)} 為起點)`)
            assert.equal(frontierOf(P, arms2).length, 1)
            //(3) 驗證類: 主張相同者(別名與正本)為同規格; 主張鍵不因改掛而變
            let arms3 = ['A01_nt', 'B16_perTradeQuality']
            let v1 = P.proposeDirection({ type: 'verify', arms: arms3, base: alias, claim: '主張丁', rationale: 'r' }, 5)
            let v2 = P.proposeDirection({ type: 'verify', arms: arms3, base: canon, claim: '主張丁', rationale: 'r' }, 5)
            let v3 = P.proposeDirection({ type: 'verify', arms: arms3, base: alias, claim: '主張戊', rationale: 'r' }, 5)
            assert.deepEqual([v1.ok, v2.ok, v3.ok], [true, false, true])
            assert(/^[0-9a-f]{8}$/.test(v1.claimKey) && v1.claimKey === v2.claimKey && v1.claimKey !== v3.claimKey && v1.nodeId === v2.nodeId && v1.nodeId !== v3.nodeId)
            assert.deepEqual(frontierOf(P, arms3).map((f) => f.spec.base), [canon, canon], '兩個不同主張之驗證、起點皆為正本')
            //(4) 探索類而與既有節點(以正本為起點)同臂同起點 ⇒ 另帶區分用之鍵(依改掛後之起點判相撞)
            let arms4 = ['A01_nt', 'B17_rollingKeys']
            let ex = { arms: arms4, base: canon }
            P.rsi.store.putNode({ id: P.idOf(ex), spec: ex, specHash: specHash(ex), status: 'executed', parents: [], round: 3 })
            let e1 = P.proposeDirection({ type: 'explore', arms: arms4, base: alias, rationale: '機制己' }, 6)
            assert(e1.ok === true && /^[0-9a-f]{8}$/.test(e1.claimKey) && e1.note.startsWith('已入前緣(與既有節點') && e1.note.includes('區分用之鍵') && e1.note.endsWith(`(起點 ${alias.slice(0, 8)} 為 ${canon.slice(0, 8)} 之別名(選集相同),已改以 ${canon.slice(0, 8)} 為起點)`), JSON.stringify(e1))
            assert.equal(P.rsi.store.listFrontier().find((f) => f.spec.claim === e1.claimKey).spec.base, canon)
        })

        it('起點為正本、不存在、未執行、被否決 ⇒ 回傳與改前逐字相同(不帶 baseUsed、不加註記);別名而正本被否決 ⇒ 否決訊息(正本)併改掛註明', () => {
            let { P, canon, alias, other } = tree()
            let r1 = P.proposeDirection({ type: 'explore', arms: ARMS, base: other, rationale: '正本為起點' }, 5)
            assert.deepEqual(r1, { ok: true, note: '已入前緣', nodeId: P.idOf({ arms: ARMS, base: other }) })
            let r2 = P.proposeDirection({ type: 'explore', arms: ['A01_nt', 'B15_newKey'], base: 'e'.repeat(64), rationale: 'x' }, 5)
            assert.deepEqual(r2, { ok: false, note: '起點 eeeeeeee 不存在或未執行' })
            let planned = { arms: ['A05_nKeys'], base: null }
            P.rsi.store.putNode({ id: P.idOf(planned), spec: planned, specHash: specHash(planned), status: 'planned', parents: [], round: 4 })
            let r3 = P.proposeDirection({ type: 'explore', arms: ['A01_nt', 'B15_newKey'], base: P.idOf(planned), rationale: 'x' }, 5)
            assert.deepEqual(r3, { ok: false, note: `起點 ${P.idOf(planned).slice(0, 8)} 不存在或未執行` })
            //被否決之起點(正本之位置): 改前之訊息
            let n2 = P.rsi.store.getNode(other)
            n2.score = { ...n2.score, flags: { vetoed: true, why: ['超過月均單上限'] } }
            P.rsi.store.putNode(n2)
            let r4 = P.proposeDirection({ type: 'explore', arms: ['A01_nt', 'B16_perTradeQuality'], base: other, rationale: 'x' }, 5)
            assert.deepEqual(r4, { ok: false, note: `起點 ${other.slice(0, 8)} 已被否決(超過月均單上限), 不得作為起點` })
            //別名之正本被否決: 否決訊息指正本、併註明改掛; 不入前緣
            let n1 = P.rsi.store.getNode(canon)
            n1.score = { ...n1.score, flags: { vetoed: true, why: ['回測期旗標 fail'] } }
            P.rsi.store.putNode(n1)
            let r5 = P.proposeDirection({ type: 'explore', arms: ['A01_nt', 'B17_rollingKeys'], base: alias, rationale: 'x' }, 5)
            assert.deepEqual(r5, { ok: false, note: `起點 ${canon.slice(0, 8)} 已被否決(回測期旗標 fail), 不得作為起點(起點 ${alias.slice(0, 8)} 為 ${canon.slice(0, 8)} 之別名(選集相同),已改以 ${canon.slice(0, 8)} 為起點)`, baseUsed: canon })
            assert.equal(frontierOf(P, ['A01_nt', 'B17_rollingKeys']).length, 0)
        })

        it('別名表取不到 ⇒ 視同無別名(照改前: 別名為起點者照常入前緣、不改掛、不帶 baseUsed),不使套用中斷', () => {
            let { P, alias } = tree()
            P.rsi.aliasMap = () => {
                throw new Error('fake: 別名表失敗')
            }
            let r = P.proposeDirection({ type: 'explore', arms: ARMS, base: alias, rationale: '別名表壞' }, 5)
            assert.deepEqual(r, { ok: true, note: '已入前緣', nodeId: P.idOf({ arms: ARMS, base: alias }) })
            assert.equal(frontierOf(P, ARMS)[0].spec.base, alias)
        })

        it('節點之來源方向:方向之起點為別名而改掛者,規格(起點 = 正本)依 baseUsed 對應到該方向(類型、主張、方向自身之起點照舊);未記 baseUsed 者不跨起點對應', () => {
            let { P, canon, alias } = tree()
            let vs = { type: 'verify', arms: ARMS, base: alias, claim: '主張庚:別名起點之驗證', rationale: 'r庚', expect: 'e庚' }
            let ex = { type: 'explore', arms: ARMS, base: canon, rationale: 'r辛', expect: 'e辛' }
            let rv = P.proposeDirection(vs, 5)
            assert(rv.ok && rv.baseUsed === canon)
            //做夢文件(輪次 5)之套用紀錄(與方向逐條對齊): 與 arsi.applyDream 之寫法相同 { arms, base: 做夢所寫, ...回傳 }
            P.records.putDreamDoc({
                round: 5,
                createdAt: '2026-11-15T00:00:00.000Z',
                agent: { model: 'm', durationSec: 1 },
                scope: { nodes: [] },
                audits: [],
                synthesis: { summary: 's', worked: [], failed: [], patterns: [] },
                guidance: { directions: [vs], avoid: [], openQuestions: [], improvements: [] },
                docsUpdated: [],
                harness: { applied: { accepted: [], rework: [], deleted: [], proposals: [{ arms: ARMS, base: alias, ...rv }], skipped: [] } },
            })
            let spec = P.rsi.store.listFrontier().find((f) => f.spec.claim === rv.claimKey).spec
            assert.equal(spec.base, canon)
            let tk = P.taskFor(spec, 6)
            assert.deepEqual([tk.type, tk.claim, tk.direction.rationale, tk.direction.base, tk.base.nodeId], ['verify', '主張庚:別名起點之驗證', 'r庚', alias, canon])
            assert.equal(P.typeOf(spec), 'verify')
            //未記 baseUsed(例: 沒有改掛之記錄)⇒ 方向之起點(別名)與規格之起點(正本)不相同 ⇒ 不對應
            P.records.putDreamDoc({ ...P.records.getDreamDoc(5), harness: { applied: { accepted: [], rework: [], deleted: [], proposals: [{ arms: ARMS, base: alias, ok: true, claimKey: rv.claimKey }], skipped: [] } } })
            assert.equal(P.typeOf(spec), 'explore')
            assert(!P.taskFor(spec, 6).direction)
            assert.equal(P.typeOf({ arms: ARMS, base: null, claim: rv.claimKey }), 'explore', '起點為 null 之規格不因「無記錄」而對到起點為別名之方向')
            //改掛之記錄只對其起點: 起點為 null 之規格不對到它; 方向之起點即正本者(無改掛)照舊對應
            P.records.putDreamDoc({ ...P.records.getDreamDoc(5), guidance: { directions: [vs, ex], avoid: [], openQuestions: [], improvements: [] }, harness: { applied: { accepted: [], rework: [], deleted: [], proposals: [{ arms: ARMS, base: alias, ...rv }, { arms: ARMS, base: canon, ok: true }], skipped: [] } } })
            assert.equal(P.typeOf({ arms: ARMS, base: null, claim: rv.claimKey }), 'explore', '起點 null 之規格不對到改掛之方向')
            assert.equal(P.taskFor({ arms: ARMS, base: canon }, 6).direction.rationale, 'r辛', '方向之起點即正本者照舊對應(不帶鍵之規格對到探索類之方向)')
            assert.equal(P.typeOf(spec), 'verify')
        })

        it('做夢文件之迴圈註記:改掛而入前緣者加一則(同一句不重複);起點非別名者、未入前緣者(正本被否決等)不加;文件不存在不拋錯', () => {
            let { P, canon, alias, other } = tree()
            P.records.putDreamDoc({
                round: 7,
                createdAt: '2026-11-15T00:00:00.000Z',
                agent: { model: 'm', durationSec: 1 },
                scope: { nodes: [] },
                audits: [],
                synthesis: { summary: 's', worked: [], failed: [], patterns: [] },
                guidance: { directions: [{ type: 'explore', arms: ARMS, base: alias, rationale: 'r' }], avoid: [], openQuestions: [], improvements: [] },
                docsUpdated: [],
            })
            let add = () => (P.records.getDreamDoc(7).harness || {}).addendum || []
            assert.deepEqual(add(), [])
            P.proposeDirection({ type: 'explore', arms: ['A01_nt', 'B15_newKey'], base: other, rationale: '非別名' }, 7)
            assert.deepEqual(add(), [], '起點非別名者不加註記')
            P.proposeDirection({ type: 'explore', arms: ARMS, base: alias, rationale: 'r' }, 7)
            let want = `方向(臂 ${ARMS.join(' + ')})之起點 ${alias.slice(0, 8)} 為 ${canon.slice(0, 8)} 之別名(選集與較早之節點逐位相同);迴圈已改以 ${canon.slice(0, 8)} 為起點入前緣,方向之內容不變,節點之來源方向照常對應。`
            assert.deepEqual(add().map((a) => a.text), [want])
            assert(/^\d{4}-\d{2}-\d{2}T/.test(add()[0].at))
            //同一句不重複(重提;前緣已有同規格 ⇒ 未入前緣,不加註記)
            let r2 = P.proposeDirection({ type: 'explore', arms: ARMS, base: alias, rationale: 'r' }, 7)
            assert(r2.ok === false && r2.baseUsed === canon, JSON.stringify(r2))
            assert.equal(add().length, 1)
            //同一句不重複(重提而入前緣者:主控把該提案結案後,同一方向重提 ⇒ 重開、ok;同一句已有 ⇒ 不再加)
            assert.equal(P.closeFrontier({ arms: ARMS, base: canon, why: '結案以測重開' }), 1)
            let r3 = P.proposeDirection({ type: 'explore', arms: ARMS, base: alias, rationale: 'r' }, 7)
            assert(r3.ok === true && r3.baseUsed === canon && r3.note.startsWith('已入前緣(重開先前已結案之同規格提案)'), JSON.stringify(r3))
            assert.equal(add().length, 1, '重開(ok)而同一句已有 ⇒ 不重複')
            //註記列於做夢文件(md)之開頭「迴圈註記」節 —— 下一輪之做夢與節點先讀之處
            let md = fs.readFileSync(P.records.paths.dreamMd(7), 'utf8')
            assert(md.includes('## 0. 迴圈註記') && md.includes(want), md.slice(0, 400))
            //文件不存在(輪次 99): 不拋錯、仍改掛
            let r = P.proposeDirection({ type: 'explore', arms: ['A01_nt', 'B16_perTradeQuality'], base: alias, rationale: 'x' }, 99)
            assert(r.ok === true && r.baseUsed === canon)
            //未入前緣者(正本被否決)不加註記:註記陳述「已改以 X 為起點入前緣」,不得與事實不符(其改掛由 note 之後綴與 baseUsed 表達)
            let n1 = P.rsi.store.getNode(canon)
            n1.score = { ...n1.score, flags: { vetoed: true, why: ['回測期旗標 fail'] } }
            P.rsi.store.putNode(n1)
            let r4 = P.proposeDirection({ type: 'explore', arms: ['A01_nt', 'B17_rollingKeys'], base: alias, rationale: '正本被否決' }, 7)
            assert(r4.ok === false && r4.baseUsed === canon && r4.note.includes('已被否決') && r4.note.endsWith('已改以 ' + canon.slice(0, 8) + ' 為起點)'), JSON.stringify(r4))
            assert.equal(add().length, 1, '未入前緣者不加註記')
        })

        it('輪末摘要:rebasedNoteOf(純函數)—— 無改掛 ⇒ []、有則首行條數與每條一行(字面值)', () => {
            assert.deepEqual(rebasedNoteOf([]), [])
            assert.deepEqual(rebasedNoteOf(undefined), [])
            assert.deepEqual(rebasedNoteOf([{ arms: ARMS, base: null, ok: true, note: '已入前緣' }, { arms: ARMS, base: 'abcdef0123456789', ok: false, note: 'x', baseUsed: '' }]), [])
            let s = rebasedNoteOf([
                { arms: ARMS, base: null, ok: true, note: '已入前緣' },
                { arms: ARMS, base: 'aaaa1111bbbb2222', ok: true, note: 'n', baseUsed: 'cccc3333dddd4444' },
                { arms: ['X09_none'], base: '1234567890abcdef', ok: false, note: 'm', baseUsed: 'fedcba0987654321' },
            ])
            assert.deepEqual(s, [
                '**方向之起點為別名 2 條**(選集與較早之節點逐位相同;迴圈已改以其正本為起點;做夢文件之迴圈註記同記)',
                '方向之起點改掛:方向 2(A01_nt + B14_pitKey;起點 aaaa1111 → cccc3333;已入前緣)',
                '方向之起點改掛:方向 3(X09_none;起點 12345678 → fedcba09;未入前緣)',
            ])
        })

        it('整合(真領域 + 假做夢):做夢之方向起點為別名 ⇒ 輪末鉤子套用後方向入前緣(起點為正本)、套用紀錄帶 baseUsed、做夢文件有迴圈註記、輪末摘要有一段;無別名者之摘要不含該段', async () => {
            let ctx = { canon: null, alias: null }
            let { P } = mk({ dreamDirs: () => [{ type: 'explore', arms: ARMS, base: ctx.alias, rationale: '別名為起點(整合)' }] })
            let [aliasArm, canonArm] = pairOf(P, 'A01_nt', 'A02_ntPit')
            ctx.canon = put(P, { arms: [canonArm], round: 1, S: 57.2, sel: 'sel-canon', k: 1 })
            ctx.alias = put(P, { arms: [aliasArm], round: 2, S: 57.2, sel: 'sel-canon', k: 2 })
            P.requestDreamOnly({ why: '整合測試' })
            let hk = await P.domain.hooks.afterRound({ round: 1, nodes: [] })
            let ap = P.records.getDreamDoc(1).harness.applied
            assert.deepEqual(ap.proposals.map((x) => [x.ok, x.base, x.baseUsed]), [[true, ctx.alias, ctx.canon]])
            assert(ap.proposals[0].note.endsWith(`已改以 ${ctx.canon.slice(0, 8)} 為起點)`), ap.proposals[0].note)
            assert.equal(frontierOf(P, ARMS)[0].spec.base, ctx.canon)
            let want = `方向之起點改掛:方向 1(${ARMS.join(' + ')};起點 ${ctx.alias.slice(0, 8)} → ${ctx.canon.slice(0, 8)};已入前緣)`
            assert(hk.lines.includes(want), JSON.stringify(hk.lines))
            assert(hk.lines.includes('**方向之起點為別名 1 條**(選集與較早之節點逐位相同;迴圈已改以其正本為起點;做夢文件之迴圈註記同記)'))
            assert(((P.records.getDreamDoc(1).harness || {}).addendum || []).length === 1)
            //無別名之樹 ⇒ 摘要不含該段
            let ctx2 = { canon: null }
            let { P: P2 } = mk({ dreamDirs: () => [{ type: 'explore', arms: ARMS, base: ctx2.canon, rationale: '正本為起點(整合)' }] })
            ctx2.canon = put(P2, { arms: ['A01_nt'], round: 1, S: 57.2, sel: 'sel-only', k: 1 })
            P2.requestDreamOnly({ why: '整合測試' })
            let hk2 = await P2.domain.hooks.afterRound({ round: 1, nodes: [] })
            assert(hk2.lines.some((l) => l.includes('方向 1 條(入前緣 1)')), JSON.stringify(hk2.lines))
            assert(!hk2.lines.some((l) => l.includes('方向之起點') || l.includes('別名')), JSON.stringify(hk2.lines))
            assert.strictEqual((P2.records.getDreamDoc(1).harness || {}).addendum, undefined)
        })
    })
})
