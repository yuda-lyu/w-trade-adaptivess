import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'
import * as REC from '../src/arsi/records.mjs'
import { acquireRunLock } from '../src/arsi/runner.mjs'
import { makeTexts } from '../src/domain/texts.mjs'

//--base 未命中之提示(排程第 614 項 ②: --base 收完整 id 或唯一之前綴 ⇒ 提示之文字隨之)
let BASE_HINT = '提示: --base 未命中同臂待執行提案之任何起點(給完整之起點節點 id 或其前綴;列示之 ←xxxxxxxx 為前 8 碼)'

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

        it('命令列: --base 未命中 ⇒ 結案 0 條(全部不動)並印提示;未給 --base ⇒ 同臂全部結案(不變)、不印提示', () => {
            let { root, P, specs } = seed()
            let r0 = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--why', '測試結案', '--base', 'c3'.repeat(32)])
            assert.equal(r0.status, 0, r0.out.join('|').slice(0, 300))
            assert(r0.out.includes('結案 0 條'), r0.out.join('|').slice(0, 300))
            assert(r0.out.includes(BASE_HINT), '未命中 ⇒ 提示(須為完整之起點節點 id 或其前綴)')
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

    //⑤ ~ ⑦: 排程第 614 項(主控已定; 第 612 項複審之範圍外與需裁示)
    //  規格之句 ⇒ 案:
    //    ⑤ 「--close 與 --rearm 之 --base 收完整之起點節點 id 或其唯一之前綴; 前綴符合多個起點者拒並列出候選; 完整 id 之行為不變; 未命中之提示保留」
    //        = 唯一前綴(含列示之 ←xxxxxxxx 8 碼)只及該起點; 模糊 ⇒ closeFrontier 拋 / rearmFrontier 回 ok: false / 命令列離開碼 1,候選 = 同臂(且主張鍵符合者)之待執行提案之起點(不含已結案者、他臂者、無起點者),全部不動;
    //          完整 id 優先於前綴; null(無起點)與 undefined(不限)之語意不變; 未命中 ⇒ 結案 0 條與提示
    //    ⑥ 「--close 改取輪次鎖(同 --rearm); --close 未給 --why 者拒並提示」= 鎖被持有 ⇒ 離開碼 3 且不動; 缺 --why ⇒ 離開碼 2 + 固定訊息、不取鎖、不動; 所有結束路徑皆釋放鎖
    //    ⑦ 「texts.mjs 另一份不去重之臂鍵改用既有之去重來源(單一實作)」= 臂之鍵只有一處定義(records.armKeyOf); 做夢範本之前次方向回顧依去重之鍵對應節點之來源方向
    //  修前(1.0.50): --base 只收完整 id(8 碼縮寫 ⇒ 結案 0 條); --close 不取鎖; --close 缺 --why 不拒; texts.mjs 以不去重之鍵比對
    describe('⑤ --base 收完整 id 或唯一之前綴(--close 與 --rearm 共用)', () => {
        let ARMS = ['A01_nt', 'B14_pitKey']
        let KEY = ARMS.join('+')
        let ARMS2 = ['A04_act']
        //起點 id 取 16 碼(同真實之節點 id 之長度); 前綴 a1 符合 P1、P2(及已結案之 BL), a2 只符合 P3
        let P1 = `a1${'0'.repeat(14)}`
        let P2 = `a1${'1'.repeat(14)}`
        let P3 = `a2${'0'.repeat(14)}`
        let BL = `a1${'f'.repeat(14)}`
        let seedP = () => {
            let { root, P } = mkProject()
            let specs = { p1: { arms: ARMS, base: P1 }, p2: { arms: ARMS, base: P2 }, p3: { arms: ARMS, base: P3 }, none: { arms: ARMS, base: null }, blk: { arms: ARMS, base: BL }, other: { arms: ['A02_ntPit'], base: P1 } }
            for (let [k, s] of Object.entries(specs)) {
                push(P, s, k === 'blk' ? 'blocked' : 'proposed')
            }
            return { root, P, specs }
        }
        let stsP = (P, specs) => Object.fromEntries(Object.entries(specs).map(([k, s]) => [k, statusOf(P, s)]))
        let ALL = { p1: 'proposed', p2: 'proposed', p3: 'proposed', none: 'proposed', blk: 'blocked', other: 'proposed' }

        it('closeFrontier: 唯一之前綴 ⇒ 只結案該起點者(同臂); 他臂之同起點、無起點、已結案者不動; 完整 id 與 8 碼縮寫皆可', () => {
            let a = seedP()
            assert.strictEqual(a.P.closeFrontier({ arms: ARMS, base: 'a2', why: '測' }), 1)
            assert.deepStrictEqual(stsP(a.P, a.specs), { ...ALL, p3: 'blocked' })
            let b = seedP()
            assert.strictEqual(b.P.closeFrontier({ arms: ARMS, base: 'a10', why: '測' }), 1)
            assert.deepStrictEqual(stsP(b.P, b.specs), { ...ALL, p1: 'blocked' }, '他臂(other)之同一起點不動')
            let c = seedP()
            assert.strictEqual(c.P.closeFrontier({ arms: ARMS, base: P2.slice(0, 8), why: '測' }), 1, '列示之 ←xxxxxxxx(前 8 碼)')
            assert.deepStrictEqual(stsP(c.P, c.specs), { ...ALL, p2: 'blocked' })
            let d = seedP()
            assert.strictEqual(d.P.closeFrontier({ arms: ARMS, base: P1, why: '測' }), 1, '完整 id 之行為不變')
            assert.deepStrictEqual(stsP(d.P, d.specs), { ...ALL, p1: 'blocked' })
        })

        it('closeFrontier: 前綴符合多個起點 ⇒ 拋錯(訊息列出候選之完整 id: 只含同臂之待執行提案之起點,不含已結案者、他臂者、無起點者); 全部不動', () => {
            let a = seedP()
            assert.throws(() => a.P.closeFrontier({ arms: ARMS, base: 'a1', why: '測' }), (err) => {
                let m = String(err && err.message)
                assert.ok(m.includes(P1) && m.includes(P2), m)
                assert.ok(!m.includes(P3) && !m.includes(BL), '不列他起點與已結案者')
                assert.ok(/2 個起點/.test(m), m)
                return true
            })
            assert.deepStrictEqual(stsP(a.P, a.specs), ALL)
        })

        it('rearmFrontier: 唯一之前綴 ⇒ 改掛該起點者; 模糊 ⇒ { ok: false, why }(列候選)、全部不動; 完整 id 不變', () => {
            let { P } = mkProject()
            let r1 = { arms: ARMS2, base: P1 }
            let r2 = { arms: ARMS2, base: P2 }
            push(P, r1, 'proposed')
            push(P, r2, 'proposed')
            let amb = P.rearmFrontier({ arms: ARMS2, base: 'a1', to: ['A02_ntPit'], why: '測' })
            assert.strictEqual(amb.ok, false)
            assert.ok(amb.why.includes(P1) && amb.why.includes(P2) && /2 個起點/.test(amb.why), amb.why)
            assert.deepStrictEqual([statusOf(P, r1), statusOf(P, r2)], ['proposed', 'proposed'])
            let ok = P.rearmFrontier({ arms: ARMS2, base: 'a10', to: ['A02_ntPit'], why: '測' })
            assert.strictEqual(ok.ok, true, JSON.stringify(ok))
            assert.deepStrictEqual([statusOf(P, r1), statusOf(P, r2)], ['blocked', 'proposed'])
            let full = P.rearmFrontier({ arms: ARMS2, base: P2, to: ['A02_ntPit'], why: '測' })
            assert.strictEqual(full.ok, true, JSON.stringify(full))
            assert.strictEqual(statusOf(P, r2), 'blocked')
        })

        it('完整 id 優先於前綴(一個起點為另一個之前綴時,給較短者之完整 id ⇒ 只及它,不判為模糊);給兩者共同之前綴 ⇒ 模糊', () => {
            let { P } = mkProject()
            let PX = `c1${'2'.repeat(6)}`
            let PY = `${PX}ff`
            let sx = { arms: ARMS, base: PX }
            let sy = { arms: ARMS, base: PY }
            push(P, sx, 'proposed')
            push(P, sy, 'proposed')
            assert.throws(() => P.closeFrontier({ arms: ARMS, base: 'c1', why: '測' }), /2 個起點/)
            assert.strictEqual(P.closeFrontier({ arms: ARMS, base: PX, why: '測' }), 1)
            assert.deepStrictEqual([statusOf(P, sx), statusOf(P, sy)], ['blocked', 'proposed'])
        })

        it('null(只無起點者)、undefined(不限)之語意不變; 未命中之前綴 ⇒ 0 條', () => {
            let a = seedP()
            assert.strictEqual(a.P.closeFrontier({ arms: ARMS, base: null, why: '測' }), 1)
            assert.deepStrictEqual(stsP(a.P, a.specs), { ...ALL, none: 'blocked' })
            assert.strictEqual(a.P.closeFrontier({ arms: ARMS, base: 'zz', why: '測' }), 0)
            assert.strictEqual(a.P.closeFrontier({ arms: ARMS, base: '10', why: '測' }), 0, '「10」只出現於 P1 之中段而非前綴 ⇒ 不是前綴(不以子字串比對)')
            assert.strictEqual(a.P.closeFrontier({ arms: ARMS, why: '測' }), 3, '未給 ⇒ 同臂待執行者全部')
            assert.deepStrictEqual(stsP(a.P, a.specs), { p1: 'blocked', p2: 'blocked', p3: 'blocked', none: 'blocked', blk: 'blocked', other: 'proposed' })
        })

        it('claim(主張鍵)限縮候選: 同前綴於不同主張鍵之同臂提案下模糊,給 claim 後唯一', () => {
            let { P } = mkProject()
            let q1 = { arms: ARMS, base: `a3${'0'.repeat(14)}`, claim: 'aaaaaaaa' }
            let q2 = { arms: ARMS, base: `a3${'1'.repeat(14)}`, claim: 'bbbbbbbb' }
            push(P, q1, 'proposed')
            push(P, q2, 'proposed')
            assert.throws(() => P.closeFrontier({ arms: ARMS, base: 'a3', why: '測' }), /2 個起點/)
            assert.strictEqual(P.closeFrontier({ arms: ARMS, base: 'a3', claim: 'aaaaaaaa', why: '測' }), 1)
            assert.deepStrictEqual([statusOf(P, q1), statusOf(P, q2)], ['blocked', 'proposed'])
        })

        it('命令列 --close --base: 唯一之前綴(含照列示抄之 8 碼)⇒ 結案 1 條(離開碼 0); 模糊 ⇒ 離開碼 1、印「未結案: …」列出候選、全部不動; 未命中 ⇒ 結案 0 條與提示(離開碼 0)', () => {
            let a = seedP()
            let r = rsiCli(a.root, ['--mode', 'frontier', '--close', KEY, '--why', '測試', '--base', P1.slice(0, 8)])
            assert.strictEqual(r.status, 0, r.out.join('|').slice(0, 300))
            assert.ok(r.out.includes('結案 1 條') && !r.out.some((l) => l.startsWith('提示:')), r.out.join('|').slice(0, 300))
            assert.deepStrictEqual(stsP(a.P, a.specs), { ...ALL, p1: 'blocked' })
            let b = seedP()
            let rb = rsiCli(b.root, ['--mode', 'frontier', '--close', KEY, '--why', '測試', '--base', 'a1'])
            assert.strictEqual(rb.status, 1, rb.out.join('|').slice(0, 300))
            let line = rb.out.find((l) => l.startsWith('未結案: '))
            assert.ok(line && line.includes(P1) && line.includes(P2) && !line.includes(P3) && !line.includes(BL), rb.out.join('|').slice(0, 400))
            assert.ok(!rb.out.some((l) => /^結案 \d+ 條/.test(l)), '不印結案數')
            assert.deepStrictEqual(stsP(b.P, b.specs), ALL, '全部不動')
            let c = seedP()
            let rc = rsiCli(c.root, ['--mode', 'frontier', '--close', KEY, '--why', '測試', '--base', 'zz'])
            assert.strictEqual(rc.status, 0)
            assert.ok(rc.out.includes('結案 0 條') && rc.out.includes(BASE_HINT), rc.out.join('|').slice(0, 300))
            assert.deepStrictEqual(stsP(c.P, c.specs), ALL)
        })

        it('--close / --rearm 之 --base 取命令列之原字串: 全為數字之前綴(10 碼)不被轉成數值 ⇒ 唯一時結案 / 改掛該起點者(數值轉型則非字串而不比前綴)', () => {
            let { root, P } = mkProject()
            let DIG = '7'.repeat(30)
            let cA = { arms: ARMS, base: DIG }
            let rA = { arms: ARMS2, base: DIG }
            let rB = { arms: ARMS2, base: P1 }
            for (let s of [cA, rA, rB]) {
                push(P, s, 'proposed')
            }
            let r = rsiCli(root, ['--mode', 'frontier', '--rearm', ARMS2.join('+'), '--to', 'A02_ntPit', '--why', '測試', '--base', '7'.repeat(10)])
            assert.strictEqual(r.status, 0, r.out.join('|').slice(0, 300))
            assert.ok(r.out.some((l) => l.startsWith('已改掛:')), r.out.join('|').slice(0, 300))
            assert.deepStrictEqual([statusOf(P, rA), statusOf(P, rB), statusOf(P, cA)], ['blocked', 'proposed', 'proposed'])
            let c = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--why', '測試', '--base', '7'.repeat(10)])
            assert.ok(c.out.includes('結案 1 條'), c.out.join('|').slice(0, 300))
            assert.strictEqual(statusOf(P, cA), 'blocked')
        })

        it('命令列 --rearm --base: 唯一之前綴 ⇒ 已改掛; 模糊 ⇒ 離開碼 1、印「未改掛: …」列出候選、不動; --close 與 --rearm 並用 ⇒ 共用同一前綴(模糊時兩者皆不執行)', () => {
            let { root, P } = mkProject()
            let c1 = { arms: ARMS, base: P1 }
            let c2 = { arms: ARMS, base: P2 }
            let r1 = { arms: ARMS2, base: P1 }
            let r2 = { arms: ARMS2, base: P2 }
            for (let s of [c1, c2, r1, r2]) {
                push(P, s, 'proposed')
            }
            let amb = rsiCli(root, ['--mode', 'frontier', '--rearm', ARMS2.join('+'), '--to', 'A02_ntPit', '--why', '測試', '--base', 'a1'])
            assert.strictEqual(amb.status, 1, amb.out.join('|').slice(0, 300))
            let line = amb.out.find((l) => l.startsWith('未改掛: '))
            assert.ok(line && line.includes(P1) && line.includes(P2), amb.out.join('|').slice(0, 400))
            //並用而模糊: --close 先失敗 ⇒ 離開碼 1、--rearm 不執行
            let both = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--rearm', ARMS2.join('+'), '--to', 'A02_ntPit', '--why', '測試', '--base', 'a1'])
            assert.strictEqual(both.status, 1, both.out.join('|').slice(0, 300))
            assert.deepStrictEqual([c1, c2, r1, r2].map((s) => statusOf(P, s)), ['proposed', 'proposed', 'proposed', 'proposed'], '模糊 ⇒ 兩者皆不執行')
            //並用而唯一(a10 = 兩臂各一個)⇒ 兩者各自只及起點符合者
            let ok = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--rearm', ARMS2.join('+'), '--to', 'A02_ntPit', '--why', '測試', '--base', 'a10'])
            assert.strictEqual(ok.status, 0, ok.out.join('|').slice(0, 300))
            assert.ok(ok.out.includes('結案 1 條') && ok.out.some((l) => l.startsWith('已改掛:')), ok.out.join('|').slice(0, 300))
            assert.deepStrictEqual([c1, c2, r1, r2].map((s) => statusOf(P, s)), ['blocked', 'proposed', 'blocked', 'proposed'])
        })
    })

    describe('⑥ --close 取輪次鎖(同 --rearm)與必給 --why', () => {
        let ARMS = ['A01_nt', 'B14_pitKey']
        let KEY = ARMS.join('+')
        let lockFp = (root) => path.join(root, 'rsi', 'logs', 'round.lock')
        let seed1 = () => {
            let { root, P } = mkProject()
            let s = { arms: ARMS, base: null }
            push(P, s, 'proposed')
            return { root, P, s }
        }

        it('--close: 另有輪次執行中(鎖被持有)⇒ 離開碼 3、印「未執行: …等它結束再結案」、前緣不動、他人之鎖不被刪; 鎖釋放後再執行 ⇒ 結案成功、鎖檔不殘留', () => {
            let { root, P, s } = seed1()
            let lk = acquireRunLock(lockFp(root))
            assert.strictEqual(lk.ok, true)
            try {
                let r = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--why', '測試'])
                assert.strictEqual(r.status, 3, r.out.join('|').slice(0, 300))
                assert.ok(r.out.some((l) => /^未執行: 有輪次或重算執行中\(pid \d+\);等它結束再結案$/.test(l)), r.out.join('|').slice(0, 300))
                assert.ok(!r.out.some((l) => /^結案 \d+ 條/.test(l)))
                assert.strictEqual(statusOf(P, s), 'proposed')
                assert.strictEqual(fs.existsSync(lockFp(root)), true, '他人持有之鎖仍在')
            }
            finally {
                lk.release()
            }
            let r2 = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--why', '測試'])
            assert.strictEqual(r2.status, 0, r2.out.join('|').slice(0, 300))
            assert.ok(r2.out.includes('結案 1 條'))
            assert.strictEqual(statusOf(P, s), 'blocked')
            assert.strictEqual(fs.existsSync(lockFp(root)), false, '鎖檔不殘留')
        })

        it('--close 與 --rearm 並用 ⇒ 一把鎖: 被持有時兩者皆不執行(離開碼 3、訊息「等它結束再結案與改掛」); --rearm 單用之訊息不變(「等它結束再改掛」)', () => {
            let { root, P, s } = seed1()
            let s2 = { arms: ['A04_act'], base: null }
            push(P, s2, 'proposed')
            let lk = acquireRunLock(lockFp(root))
            try {
                let both = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--rearm', 'A04_act', '--to', 'A02_ntPit', '--why', '測試'])
                assert.strictEqual(both.status, 3, both.out.join('|').slice(0, 300))
                assert.ok(both.out.some((l) => /等它結束再結案與改掛$/.test(l)), both.out.join('|').slice(0, 300))
                let only = rsiCli(root, ['--mode', 'frontier', '--rearm', 'A04_act', '--to', 'A02_ntPit', '--why', '測試'])
                assert.strictEqual(only.status, 3)
                assert.ok(only.out.some((l) => /^未執行: 有輪次或重算執行中\(pid \d+\);等它結束再改掛$/.test(l)), only.out.join('|').slice(0, 300))
                assert.deepStrictEqual([statusOf(P, s), statusOf(P, s2)], ['proposed', 'proposed'])
            }
            finally {
                lk.release()
            }
            let ok = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--rearm', 'A04_act', '--to', 'A02_ntPit', '--why', '測試'])
            assert.strictEqual(ok.status, 0, ok.out.join('|').slice(0, 300))
            assert.ok(ok.out.includes('結案 1 條') && ok.out.some((l) => l.startsWith('已改掛:')))
            assert.deepStrictEqual([statusOf(P, s), statusOf(P, s2)], ['blocked', 'blocked'])
            assert.strictEqual(fs.existsSync(lockFp(root)), false, '一把鎖於結束時釋放')
        })

        it('--close 未給 --why ⇒ 離開碼 2、固定訊息「invalid --close: must be used with --why」、前緣不動、未取鎖(無鎖檔、無 logs 夾之新增); --why 為空字串仍拒(既有之檢查,對照)', () => {
            let { root, P, s } = seed1()
            let before = fs.existsSync(path.join(root, 'rsi', 'logs')) ? fs.readdirSync(path.join(root, 'rsi', 'logs')).sort() : null
            let r = rsiCli(root, ['--mode', 'frontier', '--close', KEY])
            assert.strictEqual(r.status, 2)
            assert.deepStrictEqual(r.out, ['invalid --close: must be used with --why'])
            assert.strictEqual(statusOf(P, s), 'proposed')
            assert.strictEqual(fs.existsSync(lockFp(root)), false)
            let r2 = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--why', ''])
            assert.strictEqual(r2.status, 2)
            assert.deepStrictEqual(r2.out, ['invalid --why: must be written as --why <text> (a value is required)'])
            assert.strictEqual(statusOf(P, s), 'proposed')
            let after = fs.existsSync(path.join(root, 'rsi', 'logs')) ? fs.readdirSync(path.join(root, 'rsi', 'logs')).sort() : null
            assert.deepStrictEqual(after, before, '未動 logs')
        })

        it('--close 並用 --rearm 而 --rearm 缺 --to ⇒ 離開碼 2(用法)且 --close 未執行(動作之前先檢查全部之用法; 原: 先結案再報用法)', () => {
            let { root, P, s } = seed1()
            let r = rsiCli(root, ['--mode', 'frontier', '--close', KEY, '--rearm', 'A04_act', '--why', '測試'])
            assert.strictEqual(r.status, 2, r.out.join('|').slice(0, 300))
            assert.ok(r.out.some((l) => l.startsWith('用法: node g_rsi.mjs --mode frontier --rearm')), r.out.join('|').slice(0, 300))
            assert.ok(!r.out.some((l) => /^結案 \d+ 條/.test(l)))
            assert.strictEqual(statusOf(P, s), 'proposed')
            assert.strictEqual(fs.existsSync(lockFp(root)), false)
        })

        it('--close 並用 --rearm 而兩者之臂為同一集合(含次序不同、含重複之寫法)⇒ 離開碼 2、固定訊息、不取鎖、前緣不動(原: 結案後改掛側必然無提案可改而半途停止)', () => {
            let { root, P } = mkProject()
            let s = { arms: ['A04_act', 'A01_nt'], base: null }
            push(P, s, 'proposed')
            for (let [c, r] of [['A04_act+A01_nt', 'A04_act+A01_nt'], ['A04_act+A01_nt', 'A01_nt+A04_act'], ['A04_act+A01_nt', 'A01_nt+A04_act+A04_act']]) {
                let x = rsiCli(root, ['--mode', 'frontier', '--close', c, '--rearm', r, '--to', 'A02_ntPit', '--why', '測試'])
                assert.strictEqual(x.status, 2, `${c} / ${r}: ${x.out.join('|').slice(0, 300)}`)
                assert.deepStrictEqual(x.out, ['未執行: --close 與 --rearm 之臂相同(結案後無提案可改掛);請分開執行'])
                assert.strictEqual(statusOf(P, s), 'proposed')
                assert.strictEqual(fs.existsSync(lockFp(root)), false)
            }
        })

        it('預檢(dry): closeFrontier / rearmFrontier 加 dry 只回結果、不寫任何檔; 失敗之訊息與實際執行者相同(模糊之前綴、前緣無此提案、目的臂不在目錄、同規格之待執行提案、他種狀態之同規格項)', () => {
            let { P } = mkProject()
            let p1 = { arms: ARMS, base: `a1${'0'.repeat(14)}` }
            let p2 = { arms: ARMS, base: `a1${'1'.repeat(14)}` }
            let r1 = { arms: ['A04_act'], base: null }
            push(P, p1, 'proposed')
            push(P, p2, 'proposed')
            push(P, r1, 'proposed')
            let state = () => [statusOf(P, p1), statusOf(P, p2), statusOf(P, r1)]
            assert.deepStrictEqual(P.closeFrontier({ arms: ARMS, why: '測', dry: true }), 2, 'dry 回條數')
            assert.deepStrictEqual(P.closeFrontier({ arms: ARMS, base: 'a10', why: '測', dry: true }), 1)
            assert.throws(() => P.closeFrontier({ arms: ARMS, base: 'a1', why: '測', dry: true }), /2 個起點/, 'dry 之模糊照拋')
            assert.deepStrictEqual(state(), ['proposed', 'proposed', 'proposed'], 'close 之 dry 不寫')
            //rearm: 成功之預檢不寫
            let ok = P.rearmFrontier({ arms: ['A04_act'], to: ['A02_ntPit'], why: '測', dry: true })
            assert.strictEqual(ok.ok, true)
            assert.strictEqual(ok.dry, true)
            assert.deepStrictEqual(state(), ['proposed', 'proposed', 'proposed'], 'rearm 之 dry 不寫')
            assert.strictEqual(P.rsi.store.listFrontier().filter((f) => f.spec.arms.join('+') === 'A02_ntPit').length, 0, '未推入新提案')
            //失敗之訊息 dry 與實際相同(各情形於拋棄之專案各比一次: 實際之執行會改狀態)
            let cases = [
                () => ({ arms: ['A04_act'], base: null, to: ['Z99_none'] }),
                () => ({ arms: ['A04_act'], base: 'a1', to: ['A02_ntPit'] }),
                () => ({ arms: ['A02_ntPit'], to: ['A03_nt'] }),
                () => ({ arms: ['A04_act'], base: null, to: ['A04_act'] }),
            ]
            for (let mk of cases) {
                let a = mkProject()
                let b = mkProject()
                for (let Pj of [a.P, b.P]) {
                    push(Pj, { arms: ['A04_act'], base: null }, 'proposed')
                    push(Pj, { arms: ['A04_act'], base: `a1${'0'.repeat(14)}` }, 'proposed')
                    push(Pj, { arms: ['A04_act'], base: `a1${'1'.repeat(14)}` }, 'proposed')
                }
                let dry = a.P.rearmFrontier({ ...mk(a.P), why: '測', dry: true })
                let real = b.P.rearmFrontier({ ...mk(b.P), why: '測' })
                assert.strictEqual(dry.ok, real.ok, JSON.stringify([dry, real]))
                assert.strictEqual(dry.why, real.why, JSON.stringify(mk(a.P)))
            }
            //複審 L2-3: dry 須在所有會拒絕之檢查之後才返回 —— 同臂多條(不給 base)、目的規格已有節點、目的規格為待執行之提案: dry 與實際同拒、訊息同
            for (let seedMore of [
                (Pj) => {
                    push(Pj, { arms: ['A04_act'], base: null }, 'proposed')
                    push(Pj, { arms: ['A04_act'], base: `a1${'0'.repeat(14)}` }, 'proposed')
                    return { arms: ['A04_act'], to: ['A02_ntPit'] } //同臂 2 條而未給 base ⇒ 「前緣內有 2 條同臂之提案…」
                },
                (Pj) => {
                    push(Pj, { arms: ['A04_act'], base: null }, 'proposed')
                    let target = { arms: ['A02_ntPit'], base: null }
                    Pj.rsi.store.putNode({ id: Pj.idOf(target), spec: target, specHash: specHash(target), status: 'executed', parents: [], round: 1, raw: {}, score: { S: 1, ladder: 0, flags: { vetoed: false, why: [] } } })
                    return { arms: ['A04_act'], to: ['A02_ntPit'] } //目的規格已有節點 ⇒ 「同規格之節點已存在」
                },
                (Pj) => {
                    push(Pj, { arms: ['A04_act'], base: null }, 'proposed')
                    push(Pj, { arms: ['A02_ntPit'], base: null }, 'proposed')
                    return { arms: ['A04_act'], to: ['A02_ntPit'] } //目的規格為待執行之提案 ⇒ 「前緣已有同規格之提案」
                },
            ]) {
                let a = mkProject()
                let b = mkProject()
                let ia = seedMore(a.P)
                let ib = seedMore(b.P)
                let dry = a.P.rearmFrontier({ ...ia, why: '測', dry: true })
                let real = b.P.rearmFrontier({ ...ib, why: '測' })
                assert.strictEqual(real.ok, false, JSON.stringify(real))
                assert.deepStrictEqual([dry.ok, dry.why], [real.ok, real.why], '訊息逐字相同')
            }
            //同規格之項為 rejectedByGate(他種非待執行之狀態): dry 與實際同拒、訊息同; 為 blocked: dry 與實際皆可
            for (let [st, wantOk] of [['rejectedByGate', false], ['blocked', true]]) {
                let a = mkProject()
                let b = mkProject()
                for (let Pj of [a.P, b.P]) {
                    push(Pj, { arms: ['A04_act'], base: null }, 'proposed')
                    push(Pj, { arms: ['A02_ntPit'], base: null }, st)
                }
                let dry = a.P.rearmFrontier({ arms: ['A04_act'], to: ['A02_ntPit'], why: '測', dry: true })
                let real = b.P.rearmFrontier({ arms: ['A04_act'], to: ['A02_ntPit'], why: '測' })
                assert.deepStrictEqual([dry.ok, real.ok], [wantOk, wantOk], st)
                if (!wantOk) {
                    assert.strictEqual(dry.why, real.why)
                }
            }
        })

        it('--close 並用 --rearm 而改掛側於預檢即不合(前緣無此提案、前綴模糊)⇒ 兩者皆不執行(離開碼 1、印「未改掛: …」與「兩者皆未執行」、前緣全部不動、鎖釋放); 預檢通過者依序執行(目的臂不在目錄者於命令列即拒〔離開碼 2〕,見 unit-armArgs;函數層之預檢見上一案)', () => {
            let { root, P } = mkProject()
            let c1 = { arms: ARMS, base: null }
            let q1 = { arms: ['A04_act'], base: `a1${'0'.repeat(14)}` }
            let q2 = { arms: ['A04_act'], base: `a1${'1'.repeat(14)}` }
            for (let s of [c1, q1, q2]) {
                push(P, s, 'proposed')
            }
            let st3 = () => [statusOf(P, c1), statusOf(P, q1), statusOf(P, q2)]
            for (let [why, args] of [
                ['前緣無此提案', ['--rearm', 'A05_nKeys', '--to', 'A02_ntPit']],
                ['前綴模糊(改掛側)', ['--rearm', 'A04_act', '--to', 'A02_ntPit', '--base', 'a1']],
            ]) {
                let r = rsiCli(root, ['--mode', 'frontier', '--close', KEY, ...args, '--why', '測試'])
                assert.strictEqual(r.status, 1, `${why}: ${r.out.join('|').slice(0, 300)}`)
                assert.ok(r.out.some((l) => l.startsWith('未改掛: ')) && r.out.includes('(與 --close 並用: 兩者皆未執行)'), `${why}: ${r.out.join('|').slice(0, 300)}`)
                assert.ok(!r.out.some((l) => /^結案 \d+ 條/.test(l)), why)
                assert.deepStrictEqual(st3(), ['proposed', 'proposed', 'proposed'], `${why}: 全部不動`)
                assert.strictEqual(fs.existsSync(lockFp(root)), false, `${why}: 鎖釋放`)
            }
            //預檢通過(close 側 0 條、改掛側之前綴唯一)⇒ 依序執行
            let r2 = rsiCli(root, ['--mode', 'frontier', '--close', 'A01_nt+B14_pitKey', '--rearm', 'A04_act', '--to', 'A02_ntPit', '--why', '測試', '--base', 'a10'])
            assert.strictEqual(r2.status, 0, r2.out.join('|').slice(0, 300))
            assert.ok(r2.out.includes('結案 0 條') && r2.out.some((l) => l.startsWith('已改掛:')), r2.out.join('|').slice(0, 300))
            assert.deepStrictEqual(st3(), ['proposed', 'blocked', 'proposed'], '預檢通過者(close 側 a10 無同臂起點 ⇒ 0 條; 改掛側唯一)依序執行')
        })

        it('所有結束路徑皆釋放鎖: 結案 0 條、改掛失敗(前緣無此提案)、模糊之前綴 ⇒ 結束後無鎖檔', () => {
            let { root, P } = mkProject()
            push(P, { arms: ARMS, base: `a1${'0'.repeat(14)}` }, 'proposed')
            push(P, { arms: ARMS, base: `a1${'1'.repeat(14)}` }, 'proposed')
            for (let args of [
                ['--close', 'A02_ntPit', '--why', '測試'],
                ['--rearm', 'A04_act', '--to', 'A02_ntPit', '--why', '測試'],
                ['--close', KEY, '--why', '測試', '--base', 'a1'],
            ]) {
                rsiCli(root, ['--mode', 'frontier', ...args])
                assert.strictEqual(fs.existsSync(lockFp(root)), false, args.join(' '))
            }
        })
    })

    describe('⑦ 臂之鍵單一實作(去重、排序、以 + 連接)', () => {
        let walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))

        it('records.armKeyOf: 去重、排序、以 + 連接; 次序不同或含重複者同鍵; 非陣列為空字串', () => {
            assert.strictEqual(typeof REC.armKeyOf, 'function', '有 armKeyOf')
            assert.strictEqual(REC.armKeyOf(['B14_pitKey', 'A01_nt', 'A01_nt']), 'A01_nt+B14_pitKey')
            assert.strictEqual(REC.armKeyOf(['A01_nt', 'B14_pitKey']), REC.armKeyOf(['B14_pitKey', 'A01_nt', 'B14_pitKey']))
            assert.deepStrictEqual([undefined, null, 'A01_nt', 7, {}].map((x) => REC.armKeyOf(x)), ['', '', '', '', ''])
        })

        it('原始碼: 臂之鍵之定義(去重後排序再以 + 連接)全 src 只有一處(records.mjs); domain.mjs 與 texts.mjs 皆匯入使用', () => {
            let defs = []
            for (let fp of walk(path.join(FD_ROOT, 'src')).filter((f) => f.endsWith('.mjs'))) {
                fs.readFileSync(fp, 'utf8').split(/\r?\n/).forEach((l, i) => {
                    if (!/^\s*\/\//.test(l) && /\.sort\(\)\.join\(['"]\+['"]\)/.test(l)) {
                        defs.push(`${path.relative(FD_ROOT, fp).replace(/\\/g, '/')}:${i + 1}`)
                    }
                })
            }
            assert.strictEqual(defs.length, 1, defs.join(' '))
            assert.ok(defs[0].startsWith('src/arsi/records.mjs:'), defs[0])
            for (let f of ['src/domain/domain.mjs', 'src/domain/texts.mjs']) {
                let src = fs.readFileSync(path.join(FD_ROOT, f), 'utf8')
                assert.ok(/import \{[^}]*\barmKeyOf\b[^}]*\} from '\.\.\/arsi\/records\.mjs'/.test(src), `${f} 匯入 armKeyOf`)
                assert.ok(/\barmKeyOf\(/.test(src), `${f} 使用 armKeyOf`)
            }
        })

        it('做夢範本之前次方向回顧: 節點之來源方向與回顧列之臂為同一集合而一含重複 / 次序不同 ⇒ 仍對得上(預填節點自判之主張判定); 不同集合不對', () => {
            let st0 = getSettings()
            let st = { ...st0, rsi: { ...st0.rsi, guides: false, formGate: false, backfill: true, exposure: true, rankBy: 'key' } }
            let tx = makeTexts({ st, FD_ROOT: st.FD_ROOT, nStrategies: 70000 })
            let mk = (xArms, fromArms) => ({ round: 4, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r004'), context: { nodes: [{ nodeId: 'n1aaaaaaaaaaaaaa', from: { round: 3, arms: fromArms, base: null, claimKey: null }, claimVerdict: 'refuted', claimNote: '' }], prevDirections: [{ round: 3, arms: xArms, base: null, claimKey: null, rationale: 'r' }] } })
            let verdictOf = (c) => tx.dreamTemplate(c).synthesis.prevDirections[0].verdict
            assert.strictEqual(verdictOf(mk(['A01_nt', 'B14_pitKey'], ['A01_nt', 'B14_pitKey'])), 'refuted', '對照: 相同')
            assert.strictEqual(verdictOf(mk(['B14_pitKey', 'A01_nt'], ['A01_nt', 'B14_pitKey'])), 'refuted', '次序不同(原即對得上)')
            assert.strictEqual(verdictOf(mk(['A01_nt', 'A01_nt', 'B14_pitKey'], ['A01_nt', 'B14_pitKey'])), 'refuted', '回顧列之臂含重複')
            assert.strictEqual(verdictOf(mk(['A01_nt', 'B14_pitKey'], ['B14_pitKey', 'B14_pitKey', 'A01_nt'])), 'refuted', '來源方向之臂含重複')
            assert.notStrictEqual(verdictOf(mk(['A01_nt', 'B14_pitKey'], ['A01_nt', 'C19_jaccard'])), 'refuted', '不同集合不對')
        })
    })
})
