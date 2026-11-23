import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'


//前緣之操作與來源方向(排程第 481 項之現況核實後當輪修之三項; 規則 R-REC-24、R-ARM-4 之接續; R-EV-53)
//  規格之句 ⇒ 案:
//    ② 「方向之 arms 含重複者,入前緣以去重後之臂(normArms);節點之來源方向依臂之『集合』對應」= 含重複臂之方向(驗證類與探索類)其節點仍對到來源方向(類型、主張、依據);
//        臂之次序不同亦同;改掛(rearmFrontier)取同一來源方向而更新之;不含重複者不變
//    ④ 「改掛之目的規格於前緣內為已結案(blocked)者,同提案(proposeOne)之作法重開」= 改掛成功(目的 proposed、舊項 blocked、來源方向改臂);
//        目的規格為其他非待執行之狀態(rejectedByGate 等)者 ⇒ 拒,訊息註明該項之狀態;目的規格已有節點或待執行之提案者之既有拒絕不變
//    ③ 「`--close` 與 `--rearm` 對稱: 皆可以 `--base` 指明起點」= 結案只及起點相符者;未給 `--base` 者全部結案(不變);`--base` 單獨給者仍拒收
//  修前(1.0.48): armKey 不去重 ⇒ 含重複臂之方向對不到來源方向; rearmFrontier 遇目的規格已結案者回「新提案未能入前緣」; `--close` 不收 `--base`(拒收)
describe('前緣之操作與來源方向(重複臂、改掛至已結案之同規格、--close --base)', function () {
    this.timeout(300000)
    let t
    before(() => {
        t = makeTmp('frontierOps')
    })
    after(() => {
        t.cleanup()
    })
    let n = 0
    //專案: 合成帳本(命令列用)+ 專案設定 + 行程內之專案物件(同一組檔); 回 { root, P, st }
    let mkProject = () => {
        let root = path.join(t.dir, `p${n++}`)
        writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 60, nBars: 2400, seed: 7 })
        fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
        fs.mkdirSync(path.join(root, 'arms'), { recursive: true })
        fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(root, 'arms', 'base.json'))
        let st0 = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        let st = {
            ...st0,
            periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
            eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 8, seed: 1, fitEnd: { long: '2022-11-01T00:00:00', short: '2023-02-01T00:00:00' }, limits: { monthlyOrders: 400, peakHold: 50 }, timeoutSec: 240 },
            rsi: { ...st0.rsi, root: './rsi', fillParallel: 1, memberCheck: false },
            records: { nodeDir: './rsi/records/nodes', dreamDir: './rsi/records/dreams', trashDir: './rsi/records/trash', workDir: './rsi/work', toolboxDir: './rsi/toolbox' },
            dispatch: { skillsRoot: path.join(root, 'skills'), envFile: path.join(root, '.env') },
            resources: {},
        }
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st, null, 1), 'utf8')
        let sk = path.join(root, 'skills', 'node_modules', 'w-dispatch-ai')
        fs.mkdirSync(sk, { recursive: true })
        fs.writeFileSync(path.join(sk, 'package.json'), JSON.stringify({ name: 'w-dispatch-ai', main: 'index.cjs' }), 'utf8')
        fs.writeFileSync(path.join(sk, 'index.cjs'), 'module.exports = { providers: [], readEnvFile: () => ({}), dispatchOpencode: async () => ({ ok: false, error: \'stub\' }), dispatchClaude: async () => ({ ok: false, error: \'stub\' }) }\n', 'utf8')
        fs.writeFileSync(path.join(root, '.env'), '', 'utf8')
        let s = getSettings()
        s.rsi.root = path.join(root, 'rsi')
        s.records = { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work'), toolboxDir: path.join(root, 'rsi/toolbox') }
        s.eval.ledgerDir = path.join(root, 'ledger', 'eval')
        s.resources = {}
        let P = makeProject(s, { dispatch: async () => ({ ok: false, error: 'seed' }), gate: null, catalogFile: path.join(root, 'seed_catalog.json') })
        P.rsi.init()
        return { root, P, st: s }
    }
    let rsiCli = (root, args) => {
        let env = { ...process.env, ARSI_ROOT: root }
        for (let k of ['ARSI_HARNESS', 'ARSI_LEDGER_DIR', 'ARSI_EVAL_FROM', 'ARSI_AGENT_ROLE']) {
            delete env[k]
        }
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'rsi.mjs'), ...args], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 280000 })
        return { status: r.status, out: `${r.stdout}`.split(/\r?\n/).filter(Boolean), err: `${r.stderr}` }
    }
    let putDream = (P, round, directions, proposals) => P.records.putDreamDoc({
        round,
        createdAt: `2026-11-1${round}T00:00:00.000Z`,
        agent: { model: 'm', durationSec: 1 },
        scope: { nodes: [] },
        audits: [],
        synthesis: { summary: 's', worked: [], failed: [], patterns: [] },
        guidance: { directions, avoid: [], openQuestions: [], improvements: [] },
        docsUpdated: [],
        harness: { applied: { accepted: [], rework: [], deleted: [], proposals, skipped: [] } },
    })
    let push = (P, spec, status, priority = 1) => {
        let h = specHash(spec)
        P.rsi.store.pushFrontier([{ spec, specHash: h, kind: 'arm', reason: `r ${spec.arms.join('+')}`, origin: { topic: 'dream', operator: 'dream', round: 1 }, priority }])
        if (status && status !== 'proposed') {
            P.rsi.store.markFrontier([h], status)
        }
        return h
    }
    let statusOf = (P, spec) => {
        let f = P.rsi.store.listFrontier().find((x) => x.specHash === specHash(spec))
        return f ? f.status : null
    }

    describe('② 含重複臂之方向: 節點之來源方向依臂之集合對應', () => {
        it('驗證類: 方向之 arms 含重複(入前緣取去重後之臂)⇒ 節點仍對到來源方向(類型 verify、主張);臂之次序不同亦同; 對照: 不含重複者不變', () => {
            let { P } = mkProject()
            let claim = '重複臂之驗證主張'
            let dup = { type: 'verify', arms: ['B14_pitKey', 'A01_nt', 'A01_nt'], base: null, claim, rationale: 'r1', expect: 'e1' }
            let ok = { type: 'verify', arms: ['A02_ntPit', 'B14_pitKey'], base: null, claim: '對照之主張', rationale: 'r2', expect: 'e2' }
            let r1 = P.proposeDirection(dup, 1)
            let r2 = P.proposeDirection(ok, 1)
            assert(r1.ok === true && typeof r1.claimKey === 'string' && r2.ok === true, JSON.stringify([r1, r2]))
            putDream(P, 1, [dup, ok], [{ arms: dup.arms, base: null, ...r1 }, { arms: ok.arms, base: null, ...r2 }])
            //入前緣者為去重後之規格
            let specDup = { arms: ['A01_nt', 'B14_pitKey'], base: null, claim: r1.claimKey }
            assert(P.rsi.store.listFrontier().some((f) => f.specHash === specHash(specDup)), '入前緣之規格 = 去重 + 排序後之臂')
            //節點之來源方向(任務類型與主張)
            assert.equal(P.typeOf(specDup), 'verify', '含重複臂之驗證類方向之節點對到來源方向(原: 對不到 ⇒ 當作探索)')
            let tk = P.taskFor(specDup, 2)
            assert.deepEqual([tk.type, tk.claim], ['verify', claim])
            //對照: 不含重複者
            let specOk = { arms: ['A02_ntPit', 'B14_pitKey'], base: null, claim: r2.claimKey }
            assert.deepEqual([P.typeOf(specOk), P.taskFor(specOk, 2).claim], ['verify', '對照之主張'])
            //鑑別前提: 未入前緣之別種臂之集合(僅多一個臂)不對到
            assert.equal(P.typeOf({ arms: ['A01_nt', 'B14_pitKey', 'A02_ntPit'], base: null, claim: r1.claimKey }), 'explore')
        })

        it('探索類: 含重複臂之方向 ⇒ 節點之來源方向(依據、預期)對得上;改掛(rearmFrontier)取同一來源方向而更新其臂(原: 對不到 ⇒ 「無來源方向」、做夢文件之方向不更新)', () => {
            let { P } = mkProject()
            let dup = { type: 'explore', arms: ['A01_nt', 'A01_nt'], base: null, rationale: '重複臂之探索依據', expect: '預期甲' }
            let r1 = P.proposeDirection(dup, 1)
            assert(r1.ok === true, JSON.stringify(r1))
            putDream(P, 1, [dup], [{ arms: dup.arms, base: null, ...r1 }])
            let spec = { arms: ['A01_nt'], base: null }
            let tk = P.taskFor(spec, 2)
            assert.equal(tk.type, 'explore')
            assert.equal(tk.direction && tk.direction.rationale, '重複臂之探索依據', '節點對到來源方向')
            let rr = P.rearmFrontier({ arms: ['A01_nt'], to: ['A02_ntPit'], why: '測試改掛' })
            assert(rr.ok === true && rr.round === 1, `改掛取到來源方向(round 1): ${JSON.stringify(rr)}`)
            let d = P.records.getDreamDoc(1).guidance.directions[0]
            assert.deepEqual(d.arms, ['A02_ntPit'], '來源方向之臂已改')
            assert.deepEqual(d.rearmedFrom, ['A01_nt', 'A01_nt'], '原臂照記')
        })
    })

    describe('④ 改掛之目的規格於前緣內為已結案者', () => {
        let ARMS = ['A01_nt']
        let TO = ['A02_ntPit']
        let setup = () => {
            let { P } = mkProject()
            let dir = { type: 'explore', arms: ARMS, base: null, rationale: '暫掛於既有臂', expect: 'e' }
            let r = P.proposeDirection(dir, 1)
            assert(r.ok === true, JSON.stringify(r))
            putDream(P, 1, [dir], [{ arms: ARMS, base: null, ...r }])
            return P
        }
        it('目的規格為 blocked(曾提出而被結案)⇒ 改掛成功: 目的重開為 proposed、舊項 blocked、來源方向之臂改為目的(同提案之作法;原: 「新提案未能入前緣」而無從改掛)', () => {
            let P = setup()
            let target = { arms: TO, base: null }
            push(P, target, 'blocked', 3)
            assert.equal(statusOf(P, target), 'blocked')
            let rr = P.rearmFrontier({ arms: ARMS, to: TO, why: '測試改掛' })
            assert(rr.ok === true, JSON.stringify(rr))
            assert.equal(rr.nodeId, P.idOf(target))
            assert.equal(statusOf(P, target), 'proposed', '目的已重開')
            //重開者沿用該條原有之紀錄(理由、來源、優先序;同提案 proposeOne 之作法): 不以被改掛之舊項之欄位覆寫
            let re = P.rsi.store.listFrontier().find((f) => f.specHash === specHash(target))
            assert.deepEqual([re.reason, re.priority, re.origin.topic], [`r ${TO.join('+')}`, 3, 'dream'])
            let srcRow = P.rsi.store.listFrontier().find((f) => f.specHash === specHash({ arms: ARMS, base: null }))
            assert(srcRow.reason !== re.reason, '鑑別前提: 舊項與目的之理由不同')
            assert.equal(statusOf(P, { arms: ARMS, base: null }), 'blocked', '舊項已結案')
            assert.equal(rr.round, 1)
            assert.deepEqual(P.records.getDreamDoc(1).guidance.directions[0].arms, TO)
            //前緣內只有一條目的規格(不重複推入)
            assert.equal(P.rsi.store.listFrontier().filter((f) => f.specHash === specHash(target)).length, 1)
        })

        it('目的規格為其他非待執行之狀態(rejectedByGate)⇒ 拒,訊息註明該項之狀態;舊項維持待執行(不動)', () => {
            let P = setup()
            let target = { arms: TO, base: null }
            push(P, target, 'rejectedByGate')
            let rr = P.rearmFrontier({ arms: ARMS, to: TO, why: '測試改掛' })
            assert.equal(rr.ok, false)
            assert.equal(rr.why, '前緣已有同規格之項(該項狀態 rejectedByGate,不會執行)')
            assert.equal(statusOf(P, { arms: ARMS, base: null }), 'proposed')
            assert.equal(statusOf(P, target), 'rejectedByGate')
            assert.deepEqual(P.records.getDreamDoc(1).guidance.directions[0].arms, ARMS, '來源方向未動')
        })

        it('目的規格於前緣內為 executed(樹上無此節點)⇒ 拒,訊息註明該項之狀態(只有 blocked 重開)', () => {
            let P = setup()
            let target = { arms: TO, base: null }
            push(P, target, 'executed')
            let rr = P.rearmFrontier({ arms: ARMS, to: TO, why: '測試改掛' })
            assert.deepEqual(rr, { ok: false, why: '前緣已有同規格之項(該項狀態 executed,不會執行)' })
            assert.equal(statusOf(P, target), 'executed')
            assert.equal(statusOf(P, { arms: ARMS, base: null }), 'proposed')
        })

        it('既有之拒絕不變: 目的規格為待執行之提案 ⇒ 「前緣已有同規格之提案」;目的規格已有節點 ⇒ 「同規格之節點已存在」;新舊臂相同 ⇒ 「新舊之臂相同」;目的規格於前緣內不存在而推入 ⇒ 成功(對照)', () => {
            let P = setup()
            let target = { arms: TO, base: null }
            push(P, target, 'proposed')
            assert.deepEqual(P.rearmFrontier({ arms: ARMS, to: TO, why: 'x' }), { ok: false, why: '前緣已有同規格之提案' })
            let P2 = setup()
            let id = P2.idOf(target)
            P2.rsi.store.putNode({ id, spec: target, specHash: specHash(target), status: 'executed', parents: [], round: 1, raw: {}, score: { S: 1, ladder: 0, flags: { vetoed: false, why: [] } } })
            let r2 = P2.rearmFrontier({ arms: ARMS, to: TO, why: 'x' })
            assert(r2.ok === false && r2.why === `同規格之節點已存在(${id.slice(0, 8)} executed)`, JSON.stringify(r2))
            let P3 = setup()
            assert.deepEqual(P3.rearmFrontier({ arms: ARMS, to: ARMS, why: 'x' }), { ok: false, why: '新舊之臂相同' })
            let r4 = P3.rearmFrontier({ arms: ARMS, to: TO, why: 'x' })
            assert(r4.ok === true, JSON.stringify(r4))
        })
    })

    describe('③ --close 之 --base(與 --rearm 對稱)', () => {
        let ARMS = ['A01_nt', 'B14_pitKey']
        let KEY = ARMS.join('+')
        let B1 = 'b1'.repeat(32)
        let B2 = 'b2'.repeat(32)
        let seed = () => {
            let { root, P } = mkProject()
            let specs = { s0: { arms: ARMS, base: null }, s1: { arms: ARMS, base: B1 }, s2: { arms: ARMS, base: B2 }, other: { arms: ['A02_ntPit'], base: B1 } }
            for (let s of Object.values(specs)) {
                push(P, s, 'proposed')
            }
            return { root, P, specs }
        }
        let sts = (P, specs) => Object.fromEntries(Object.entries(specs).map(([k, s]) => [k, statusOf(P, s)]))
        it('命令列: --close <臂> --base <起點> ⇒ 只結案起點相符者(印「結案 1 條」);他起點、無起點、他臂之提案不動', () => {
            let { root, P, specs } = seed()
            let r = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--why', '測試結案', '--base', B1])
            assert.equal(r.status, 0, `${r.out.join('|').slice(0, 300)} ${r.err.slice(0, 300)}`)
            assert(r.out.includes('結案 1 條'), r.out.join('|').slice(0, 300))
            assert.deepEqual(sts(P, specs), { s0: 'proposed', s1: 'blocked', s2: 'proposed', other: 'proposed' })
        })

        it('命令列: --base 未命中 ⇒ 結案 0 條(全部不動);未給 --base ⇒ 同臂全部結案(不變)', () => {
            let { root, P, specs } = seed()
            let r0 = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--why', '測試結案', '--base', 'c3'.repeat(32)])
            assert.equal(r0.status, 0, r0.out.join('|').slice(0, 300))
            assert(r0.out.includes('結案 0 條'), r0.out.join('|').slice(0, 300))
            assert(r0.out.includes('提示: --base 須為完整之起點節點 id(列示之 ←xxxxxxxx 只印前 8 碼)'), '未命中 ⇒ 提示 --base 須為完整 id')
            assert.deepEqual(sts(P, specs), { s0: 'proposed', s1: 'proposed', s2: 'proposed', other: 'proposed' })
            //照列示抄前 8 碼(列示之 ←xxxxxxxx)者 ⇒ 同樣 0 條與提示(須為完整之 id)
            let r8 = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--why', '測試結案', '--base', B1.slice(0, 8)])
            assert(r8.out.includes('結案 0 條') && r8.out.some((l) => l.startsWith('提示: --base 須為完整')), r8.out.join('|').slice(0, 300))
            assert.deepEqual(sts(P, specs), { s0: 'proposed', s1: 'proposed', s2: 'proposed', other: 'proposed' })
            //未給 --base ⇒ 不印提示
            let r = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--why', '測試結案'])
            assert(r.out.includes('結案 3 條') && !r.out.some((l) => l.startsWith('提示:')), r.out.join('|').slice(0, 300))
            assert.deepEqual(sts(P, specs), { s0: 'blocked', s1: 'blocked', s2: 'blocked', other: 'proposed' })
        })

        it('同時給 --close 與 --rearm: --base 兩者共用(各自只及起點相符者;原 --base 只用於 --rearm,--close 不受限)', () => {
            let { root, P } = mkProject()
            let ARMS2 = ['A04_act']
            let c1 = { arms: ARMS, base: B1 }
            let c2 = { arms: ARMS, base: B2 }
            let r1 = { arms: ARMS2, base: B1 }
            let r2 = { arms: ARMS2, base: B2 }
            for (let s of [c1, c2, r1, r2]) {
                push(P, s, 'proposed')
            }
            let r = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--rearm', ARMS2.join('+'), '--to', 'A02_ntPit', '--why', '測試', '--base', B1])
            assert.equal(r.status, 0, `${r.out.join('|').slice(0, 300)} ${r.err.slice(0, 300)}`)
            assert(r.out.includes('結案 1 條') && r.out.some((l) => l.startsWith('已改掛:')), r.out.join('|').slice(0, 300))
            assert.deepEqual([statusOf(P, c1), statusOf(P, c2), statusOf(P, r1), statusOf(P, r2)], ['blocked', 'proposed', 'blocked', 'proposed'])
        })

        it('--base 取命令列之原字串: 全為數字之起點 id 不被轉成數值(數值轉型會丟掉位數而對不到);同臂他起點不動', () => {
            let { root, P } = mkProject()
            let DIG = '7'.repeat(30)
            let sA = { arms: ARMS, base: DIG }
            let sB = { arms: ARMS, base: B1 }
            push(P, sA, 'proposed')
            push(P, sB, 'proposed')
            let r = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--why', '測試結案', '--base', DIG])
            assert.equal(r.status, 0, r.out.join('|').slice(0, 300))
            assert(r.out.includes('結案 1 條'), r.out.join('|').slice(0, 300))
            assert.deepEqual([statusOf(P, sA), statusOf(P, sB)], ['blocked', 'proposed'])
        })

        it('--base 單獨給(無 --close / --rearm)仍拒收(離開碼 2、固定訊息、不寫任何檔);--rearm 之 --base 照舊', () => {
            let { root, P, specs } = seed()
            let r = rsiCli(root, ['--mode', 'frontier', '--base', B1])
            assert.equal(r.status, 2)
            assert.deepEqual(r.out, ['invalid --base: must be used with --close or --rearm'])
            assert.deepEqual(sts(P, specs), { s0: 'proposed', s1: 'proposed', s2: 'proposed', other: 'proposed' })
            //--rearm 之 --base: 起點相符之一條改掛
            let r2 = rsiCli(root, ['--mode', 'frontier', '--rearm', KEY, '--to', 'A02_ntPit+B14_pitKey', '--why', '測試改掛', '--base', B2])
            assert(r2.out.some((l) => l.startsWith('已改掛:')), r2.out.join('|').slice(0, 300))
            assert.equal(statusOf(P, specs.s2), 'blocked')
            assert.equal(statusOf(P, specs.s1), 'proposed')
        })
    })
})
