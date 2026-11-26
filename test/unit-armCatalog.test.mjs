import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { mkArm, proposalOf, decideArgsOf } from '../src/domain/armCatalog.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { checkNodeAgentPart, checkDreamAgentPart, tallyDream, renderDreamMd, checkArmProposals } from '../src/arsi/records.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'

describe('臂目錄之提案、審定與生效目錄(規則 R-ARM-1 ~ R-ARM-3;引擎之治理 rsi.governance)', function () {
    let t
    before(() => {
        t = makeTmp('armCatalog')
    })
    after(() => {
        t.cleanup()
    })

    let cat = () => ({
        layers: { A: '資格層', B: '排序鍵層', J: '封鎖' },
        arms: [mkArm({ id: 'A01_nt', n: 1, title: '交易數資格', desc: '說明', selectable: true, grid: { ntMax: [50] } }), mkArm({ id: 'B02_key', n: 2, title: '排序鍵', desc: '說明', selectable: true }), mkArm({ id: 'B03_static', n: 3, title: '靜態鍵', desc: '說明', selectable: false })],
    })

    it('mkArm:臂之標準形 —— 層 = id 之首字、狀態 proposed;可選者之落成名 = 算子 add:<id> + 載體 <id>,不可選者為 manual;說明與格點有給才列', () => {
        //R-ARM-2: 新臂與基底同形(領域依落成名登錄算子與載體)
        assert.deepEqual(mkArm({ id: 'A04_x', n: 4, title: 't', desc: 'd', selectable: true, grid: { k: [1] } }), { id: 'A04_x', n: 4, layer: 'A', title: 't', desc: 'd', status: 'proposed', selectable: true, realize: [{ kind: 'operator', op: 'add:A04_x' }, { kind: 'carrier', name: 'A04_x' }], grid: { k: [1] } })
        let b = mkArm({ id: 'I05_y', n: 5, title: 't', selectable: false })
        assert(b.selectable === false && b.realize.length === 1 && b.realize[0].kind === 'manual' && !('desc' in b) && !('grid' in b))
    })

    it('decideArgsOf(主控之命令列 → 引擎之審定參數):不採只帶理由;新臂之 id 接全目錄之最大序號、落成名依 id、說明與名稱預設取提案;參數不足即回錯誤', () => {
        let p = { id: 'P001', kind: 'new', layer: 'A', title: '進場價位風格', mechanism: '依進場當下之價位位置分類' }
        //不採: 不需目錄之變更(--name 等選項不入參數)
        assert.deepEqual(decideArgsOf(p, { accept: false, why: '重疊', name: 'x' }), { args: { accept: false, why: '重疊', by: '主控' } })
        //新臂: --name + 提案所寫之層 ⇒ <層><全目錄最大序號 + 1>_<英數名>(非英數略去)、預設可選、n 交引擎配
        let a = decideArgsOf(p, { accept: true, why: '機制獨立', name: 'entryPrice', catalog: cat() }).args
        assert.deepEqual(a, { accept: true, why: '機制獨立', by: '主控', arm: { id: 'A04_entryPrice', layer: 'A', title: '進場價位風格', desc: '依進場當下之價位位置分類', status: 'proposed', selectable: true, realize: [{ kind: 'operator', op: 'add:A04_entryPrice' }, { kind: 'carrier', name: 'A04_entryPrice' }] } })
        //--layer / --title / --desc 覆寫提案; --selectable false ⇒ 落成名為 manual
        let b = decideArgsOf(p, { accept: true, why: 'w', name: 'k', layer: 'B', title: '名', desc: '中性描述', selectable: false, catalog: cat() }).args.arm
        assert(b.id === 'B04_k' && b.layer === 'B' && b.title === '名' && b.desc === '中性描述' && b.selectable === false && b.realize[0].kind === 'manual')
        //--arm-id 須合式且層存在
        assert.equal(decideArgsOf(p, { accept: true, why: 'w', armId: 'A09_given', catalog: cat() }).args.arm.id, 'A09_given')
        assert(/--arm-id/.test(decideArgsOf(p, { accept: true, why: 'w', armId: 'Q09_x', catalog: cat() }).error))
        assert(/--arm-id/.test(decideArgsOf(p, { accept: true, why: 'w', armId: 'A9', catalog: cat() }).error))
        //未給 --name、或層不存在 ⇒ 錯誤(列出現有層)
        assert(/--name.*現有層: A B J/.test(decideArgsOf(p, { accept: true, why: 'w', catalog: cat() }).error))
        assert(/--name/.test(decideArgsOf({ ...p, layer: 'Z' }, { accept: true, why: 'w', name: 'k', catalog: cat() }).error))
    })

    it('decideArgsOf:新層取下一個未用之字母(或 --layer)、層名接 --desc;修訂只改明給之欄(說明預設取提案)、--no-grid ⇒ grid {}、可選與否有變者連落成名;停用不另給', () => {
        let pl = { id: 'P002', kind: 'layer', title: '資訊源層', mechanism: '以資訊源為軸' }
        assert.deepEqual(decideArgsOf(pl, { accept: true, why: 'w', catalog: cat() }).args.layer, { id: 'C', title: '資訊源層' })
        assert.deepEqual(decideArgsOf(pl, { accept: true, why: 'w', layer: 'K', desc: '以資訊源分類', catalog: cat() }).args.layer, { id: 'K', title: '資訊源層:以資訊源分類' })
        let pr = { id: 'P003', kind: 'revise', arm: 'A01_nt', title: '提案之名(不採用)', mechanism: '修訂後之定義' }
        //只給 --why ⇒ patch 只有說明(= 提案之 mechanism); 名稱不因提案之 title 而改
        assert.deepEqual(decideArgsOf(pr, { accept: true, why: 'w', catalog: cat() }).args.arm, { desc: '修訂後之定義' })
        //--no-grid: 引擎之修訂不能刪鍵 ⇒ 空格點
        assert.deepEqual(decideArgsOf(pr, { accept: true, why: 'w', title: '新名', desc: '改寫', noGrid: true, catalog: cat() }).args.arm, { title: '新名', desc: '改寫', grid: {} })
        //可選 → 不可選: 連落成名(manual); 與現況相同者不列
        let off = decideArgsOf(pr, { accept: true, why: 'w', selectable: false, catalog: cat() }).args.arm
        assert(off.selectable === false && off.realize.length === 1 && off.realize[0].kind === 'manual')
        assert(!('realize' in decideArgsOf(pr, { accept: true, why: 'w', selectable: true, catalog: cat() }).args.arm))
        let on = decideArgsOf({ ...pr, arm: 'B03_static' }, { accept: true, why: 'w', selectable: true, catalog: cat() }).args.arm
        assert(on.selectable === true && on.realize[0].op === 'add:B03_static')
        assert(/不在目錄/.test(decideArgsOf({ ...pr, arm: 'Z99_none' }, { accept: true, why: 'w', catalog: cat() }).error))
        //停用: 只帶理由
        assert.deepEqual(decideArgsOf({ id: 'P004', kind: 'retire', arm: 'A01_nt', mechanism: '重疊' }, { accept: true, why: '併入他臂', catalog: cat() }), { args: { accept: true, why: '併入他臂', by: '主控' } })
    })

    it('proposalOf:提案轉為引擎之提案形 —— 非字串之選配欄當成未給、出處只留字串(否則引擎整筆不收)', () => {
        assert.deepStrictEqual(proposalOf({ kind: 'new', layer: ' A ', title: 't', mechanism: ' m ', boundary: 3, evidence: ['x'], sources: ['n1', 2], nodeId: 'zz' }), { kind: 'new', arm: null, layer: 'A', title: 't', mechanism: 'm', boundary: null, evidence: null, sources: ['n1'] })
    })

    describe('與引擎之治理接線(makeProject 於暫存之狀態根;不派工)', function () {
        let st
        let fpCat
        let mk = () => makeProject(st, { dispatch: async () => ({ ok: false, error: '測試不派工' }), gate: null, catalogFile: fpCat })
        let base = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'arms', 'base.json'), 'utf8'))
        before(() => {
            st = getSettings()
            let d = path.join(t.dir, 'proj')
            st.rsi.root = path.join(d, 'rsi')
            st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
            st.eval.ledgerDir = path.join(d, 'ledger')
            fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
            fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synth' }), 'utf8')
            fpCat = path.join(d, 'catalog.json')
        })

        it('無擴充(未用治理)⇒ 生效目錄即基底;供 agent 閱讀之目錄 = 基底(臂、層相同);內容不變不重寫', () => {
            //R-ARM-2: 生效目錄 = 基底 + 擴充; 無擴充檔 ⇒ 只有基底(狀態根不建 governance 夾)
            let P = mk()
            assert.equal(P.catalog.arms.length, base.arms.length)
            assert.deepEqual(P.catalog.layers, base.layers)
            let w = P.writeCatalogFile()
            assert(w.written === true && w.nExt === 0 && w.nArms === base.arms.length)
            let out = JSON.parse(fs.readFileSync(fpCat, 'utf8'))
            assert.deepEqual(out.arms, base.arms)
            assert.equal(out.note, base.note)
            assert.equal(P.writeCatalogFile().written, false, '內容不變則不寫')
            assert(!fs.existsSync(P.rsi.paths.governance), '未用治理之狀態根無 governance 夾')
        })

        it('提案入帳:正規化後之提案引擎照收;形不合者(新臂無名稱)列於 invalid;與待審者同鍵者補記再提', () => {
            //R-ARM-1: 節點與做夢提案入帳待審; 已在帳上者不另立
            let g = mk().rsi.governance
            let r = g.propose({ round: 3, from: 'dream', items: [{ kind: 'new', layer: 'A', title: '進場價位風格', mechanism: '依進場當下之價位位置分類', evidence: 7 }, { kind: 'new', mechanism: '無名稱' }].map(proposalOf) })
            assert.deepEqual([r.added.map((x) => [x.id, x.status, x.round, x.from]), r.invalid.map((x) => x.index)], [[['P001', 'pending', 3, 'dream']], [1]])
            let r2 = g.propose({ round: 4, from: 'aaaa111122223333', items: [proposalOf({ kind: 'new', layer: 'A', title: '進場 價位風格', mechanism: '同一件事' })] })
            assert(r2.added.length === 0 && r2.repeated.length === 1 && /再提/.test(g.ledger().items[0].note))
            assert(fs.readFileSync(mk().rsi.paths.govProposalsMd, 'utf8').includes('## 待審(1 筆)'), '提案帳之渲染檔由引擎產生')
        })

        it('審定(新層、新臂、修訂 --no-grid / --selectable false、停用、不採)⇒ 下一次組裝之生效目錄、引擎之 rsi.arms、算子與供 agent 閱讀之目錄皆隨之;停用基底之可選臂不使組裝失敗', () => {
            let P = mk()
            let g = P.rsi.governance
            let ids = g.propose({
                round: 5,
                from: 'dream',
                items: [
                    { kind: 'layer', title: '資訊源層', mechanism: '以資訊源為軸' },
                    { kind: 'revise', arm: 'A01_nt', mechanism: '修訂後之定義(移除格點)' },
                    { kind: 'revise', arm: 'A02_ntPit', mechanism: '改為不可選' },
                    { kind: 'retire', arm: 'B17_rollingKeys', mechanism: '與他臂重疊' },
                    { kind: 'new', layer: 'B', title: '不採之新臂', mechanism: 'x' },
                ].map(proposalOf)
            }).added.map((x) => x.id)
            let dec = (id, o) => {
                let a = decideArgsOf(g.list().find((x) => x.id === id), { why: '審定理由', ...o, catalog: g.effectiveCatalog() })
                assert(!a.error, a.error)
                return g.decide(id, a.args)
            }
            let dl = dec(ids[0], { accept: true })
            let layer = dl.item.decision.ref
            //新臂(P001 之「進場價位風格」)掛在新層之下: 層存在才可通過
            let dn = dec('P001', { accept: true, name: 'entryPrice', layer })
            let armNew = dn.item.decision.ref
            assert.equal(armNew, `${layer}${String(base.arms.length + 1).padStart(2, '0')}_entryPrice`)
            dec(ids[1], { accept: true, noGrid: true })
            dec(ids[2], { accept: true, selectable: false })
            dec(ids[3], { accept: true })
            let extN = g.extensions().arms.length
            dec(ids[4], { accept: false })
            assert.equal(g.extensions().arms.length, extN, '不採不寫擴充檔')
            assert.deepEqual(g.ledger().items.map((x) => x.status), ['accepted', 'accepted', 'accepted', 'accepted', 'accepted', 'rejected'])
            //下一次組裝(新程序同此): 領域與引擎皆以基底 + 擴充為目錄
            let Q = mk()
            let byId = new Map(Q.catalog.arms.map((a) => [a.id, a]))
            assert.equal(Q.catalog.layers[layer], '資訊源層')
            assert(Q.selectable.some((a) => a.id === armNew) && Q.layerOfSpec({ arms: [armNew, 'A01_nt'] }) === layer, '新臂可選、屬新層')
            assert(Q.rsi.arms.list({ selectable: true }).some((a) => a.id === armNew) && !(Q.rsi.arms.warnings || []).length, '引擎之目錄亦可選(算子已登錄 ⇒ 無治理之警告)')
            assert(Q.domain.operators.some((o) => o.name === `add:${armNew}` && o.applies({ arms: ['A01_nt'] })))
            //修訂: 說明改、格點移除(任務書之格點為無)
            assert(byId.get('A01_nt').desc === '修訂後之定義(移除格點)' && Object.keys(byId.get('A01_nt').grid).length === 0)
            assert.strictEqual(Q.taskFor({ arms: ['A01_nt'], base: null }).arms[0].grid, null)
            //修訂為不可選: 不出算子、不可指派
            assert(!Q.selectable.some((a) => a.id === 'A02_ntPit') && !Q.domain.operators.some((o) => o.name === 'add:A02_ntPit'))
            assert.throws(() => Q.domain.validateSpec({ arms: ['A02_ntPit'], base: null }), /不可選/)
            //停用: 留在目錄(樹上節點引用得到)、blocked、不可選; 其算子登錄而永不適用
            let rt = byId.get('B17_rollingKeys')
            assert(rt.status === 'blocked' && /與他臂重疊|審定理由/.test(rt.blockedBy) && rt.selectable !== true && !Q.selectable.some((a) => a.id === 'B17_rollingKeys'))
            let opR = Q.domain.operators.find((o) => o.name === 'add:B17_rollingKeys')
            assert(opR && !opR.applies({ arms: ['A01_nt'] }) && !Q.domain.carriers().B17_rollingKeys)
            //供 agent 閱讀之目錄: 隨看板(或主控審定後)重寫; 不含出處、空格點不列; 註明擴充筆數與提案帳之渲染檔
            let w = Q.writeCatalogFile()
            let out = JSON.parse(fs.readFileSync(fpCat, 'utf8'))
            assert(w.written && w.nExt === 5 && out.arms.length === base.arms.length + 1 && out.arms.every((a) => a.origin === undefined))
            assert(!('grid' in out.arms.find((a) => a.id === 'A01_nt')) && out.layers[layer] === '資訊源層')
            assert(out.note.startsWith(base.note) && out.note.includes('另有擴充 5 筆') && out.note.includes('governance/PROPOSALS.md'))
        })

        it('擴充檔損壞 ⇒ 組裝拋錯(不靜默當成無擴充,否則已審定之臂無聲消失)', () => {
            let fp = mk().rsi.paths.govExtensions
            let keep = fs.readFileSync(fp, 'utf8')
            fs.writeFileSync(fp, '{bad', 'utf8')
            try {
                assert.throws(() => mk(), /擴充/)
            }
            finally {
                fs.writeFileSync(fp, keep, 'utf8')
            }
            assert.doesNotThrow(() => mk())
        })
    })

    it('節點文件與做夢文件之 armProposals:選配;格式不合列為文件問題;筆數入統計;渲染於文件', () => {
        assert.deepEqual(checkArmProposals([], 'x'), [])
        assert.deepEqual(checkArmProposals('x', 'g'), ['g 須為陣列(沒有提案給空陣列)'])
        let issues = checkArmProposals([{ kind: 'new', title: 't', mechanism: 'm' }, { kind: 'merge', mechanism: 'm' }, { kind: 'new', mechanism: 'm' }, { kind: 'retire', mechanism: 'm' }, { kind: 'layer', title: 't', mechanism: ' ' }, { kind: 'revise', arm: 'A01_nt', mechanism: 'm', sources: 'x' }], 'g')
        assert.equal(issues.length, 5)
        assert(/g\[1\]\.kind/.test(issues[0]) && /g\[2\].*title/.test(issues[1]) && /g\[3\].*arm/.test(issues[2]) && /g\[4\]\.mechanism/.test(issues[3]) && /g\[5\]/.test(issues[4]))
        let node = { plan: { target: 't', approach: 'a' }, code: { artifact: 'p' }, results: { claimed: {} }, conclusion: { outcome: 'neutral', summary: 's' } }
        assert.deepEqual(checkNodeAgentPart(node), [], '無此欄照常合格')
        assert.deepEqual(checkNodeAgentPart({ ...node, conclusion: { ...node.conclusion, armProposals: [] } }), [])
        assert(checkNodeAgentPart({ ...node, conclusion: { ...node.conclusion, armProposals: [{ kind: 'x' }] } }).some((x) => x.includes('conclusion.armProposals[0].kind')))
        let aps = [{ kind: 'new', layer: 'A', title: '進場價位風格', mechanism: '依進場當下之價位位置分類', boundary: '與 A10 之差', evidence: '依據', sources: ['9d2b9a35'] }, { kind: 'retire', arm: 'A03_midHighFreq', mechanism: '與 A02 重疊' }]
        let dream = { audits: [], synthesis: { summary: 's', worked: [], failed: [], patterns: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: aps } }
        assert(!checkDreamAgentPart(dream, []).some((x) => x.includes('armProposals')))
        assert(checkDreamAgentPart({ ...dream, guidance: { ...dream.guidance, armProposals: [{ kind: 'new', mechanism: 'm' }] } }, []).some((x) => x.includes('guidance.armProposals[0]')))
        assert.deepEqual(tallyDream(dream).armProposals, { total: 2, new: 1, layer: 0, revise: 0, retire: 1 })
        assert.deepEqual(tallyDream({ guidance: {} }).armProposals, { total: 0, new: 0, layer: 0, revise: 0, retire: 0 })
        let md = renderDreamMd({ round: 9, createdAt: '2026-11-13T00:00:00.000Z', agent: { model: 'm', durationSec: 1 }, scope: { nodes: [] }, ...dream, harness: {} })
        assert(md.includes('- 臂目錄之提案(待主控審查;通過者下一輪加入目錄):') && md.includes('〔新臂〕進場價位風格(層:A):依進場當下之價位位置分類;與既有臂之界線:與 A10 之差(依據:依據)(出處:9d2b9a35)') && md.includes('〔停用〕A03_midHighFreq :與 A02 重疊'))
        assert(!renderDreamMd({ round: 9, createdAt: '2026-11-13T00:00:00.000Z', agent: { model: 'm', durationSec: 1 }, scope: { nodes: [] }, ...dream, guidance: { ...dream.guidance, armProposals: undefined }, harness: {} }).includes('臂目錄之提案'), '舊文件不出現此列')
    })

    it('節點文件之主張判定(conclusion.claimVerdict;選配):只收 confirmed / refuted;不在值域列為文件問題', () => {
        //相對對照之 outcome 與「主張是否成立」是兩件事
        let node = (c) => ({ plan: { target: 't', approach: 'a' }, code: { artifact: 'p' }, results: { claimed: {} }, conclusion: { outcome: 'improved', summary: 's', ...c } })
        assert.deepEqual(checkNodeAgentPart(node({ claimVerdict: 'refuted', claimNote: '判定 ② 差 0.04' })), [])
        assert.deepEqual(checkNodeAgentPart(node({ claimVerdict: null })), [])
        assert(checkNodeAgentPart(node({ claimVerdict: 'inconclusive' })).some((x) => x.includes('conclusion.claimVerdict')))
        assert(checkNodeAgentPart(node({ claimVerdict: 'confirmed', claimNote: 3 })).some((x) => x.includes('conclusion.claimNote')))
    })
})
