import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { specHash } from '../src/engineApi.mjs'
import { armListMsgOf } from '../src/domain/armCatalog.mjs'
import { acquireRunLock } from '../src/arsi/runner.mjs'
import { makeTmp } from './tools/synthLedger.mjs'
import { makeSynthProject, runEntry } from './tools/synthProject.mjs'


//--close / --rearm 之臂參數取原字串並對照臂目錄(排程第 622 項 ③; 複審 L-3、L-4)
//  規格之句 ⇒ 案:
//    ① 「臂參數取命令列之原字串」= `--close 0` 不再被轉成數值而當成未給(原: 不結案、離開碼 0)⇒ 離開碼 2
//    ② 「不在臂目錄者拒(離開碼 2;先於取鎖與任何動作)」= 全部不在 / 部分不在(合格之部分亦不結案)/ 空字串 / 空段(`A++B`)/ 前後空白 / 大小寫不同 / 前綴; --rearm 之原臂與 --to 之目的臂同(--to 另須為可選之臂)
//    ③ 「錯誤訊息不回顯輸入之臂(固定詞彙)」= 訊息為固定之 `invalid --<旗標>: must be …arm ids of the arm catalog, joined with +`,不含輸入之任何片段
//    ④ 「合格者不變」= 目錄內之臂(含無提案者 ⇒ 結案 0 條、已停用之臂 ⇒ 仍可結案與改掛)照舊; 取鎖之失敗、模糊之前綴等既有之離開碼不變
//  修前(tadm9 之工作樹): `argOf` 取值 ⇒ `--close 0` 離開碼 0 而不執行; 臂不在目錄者只印「結案 0 條」或「未改掛: 臂 <臂> 不在目錄」(回顯輸入)
let FIXED = (nm, sel = false) => `invalid --${nm}: must be ${sel ? 'selectable ' : ''}arm ids of the arm catalog, joined with +`

describe('--close / --rearm 之臂參數:原字串 + 對照臂目錄(排程第 622 項 ③)', function () {
    this.timeout(300000)
    let t
    before(() => {
        t = makeTmp('armArgs')
    })
    after(() => {
        t.cleanup()
    })
    let n = 0
    let mk = () => makeSynthProject(t.dir, `p${n++}`)
    let push = (P, spec) => {
        P.rsi.store.pushFrontier([{ spec, specHash: specHash(spec), kind: 'arm', reason: `r ${spec.arms.join('+')}`, origin: { topic: 'dream', operator: 'dream', round: 1 }, priority: 1 }])
    }
    let statusOf = (P, spec) => {
        let f = P.rsi.store.listFrontier().find((x) => x.specHash === specHash(spec))
        return f ? f.status : null
    }
    let cli = (root, args) => runEntry(root, ['src', 'cli', 'rsi.mjs'], ['--mode', 'frontier', ...args])
    let lockFp = (root) => path.join(root, 'rsi', 'logs', 'round.lock')

    it('armListMsgOf(純函數): 目錄內之臂以 id 完全相同才算; 空段、空字串、非字串、前後空白、大小寫、前綴皆不合; 訊息固定、不含輸入之任何片段; selectable 者另要求可選', () => {
        let arms = [{ id: 'A01_nt', selectable: true }, { id: 'B14_pitKey', selectable: true }, { id: 'A12_universe', selectable: false }, { id: 'D31_runawayGuard' }]
        for (let ok of ['A01_nt', 'A01_nt+B14_pitKey', 'B14_pitKey+A01_nt', 'A12_universe', 'A01_nt+A01_nt', 'D31_runawayGuard']) {
            assert.equal(armListMsgOf('close', ok, arms), null, ok)
        }
        for (let bad of ['0', '', '+', 'A01_nt+', '+A01_nt', 'A01_nt++B14_pitKey', ' A01_nt', 'A01_nt ', 'a01_nt', 'A01', 'A01_nt+Z99_none', 'Z99_none', 0, null, undefined, true, ['A01_nt'], { id: 'A01_nt' }]) {
            let m = armListMsgOf('close', bad, arms)
            assert.equal(m, FIXED('close'), String(bad))
            if (typeof bad === 'string' && bad.length > 0) {
                assert.ok(!m.includes(bad.trim()) || bad.trim() === '+' || bad.trim() === '', `訊息不回顯輸入: ${m}`)
            }
        }
        //可選之要求(--to): 不可選者(selectable 為 false 或未給)不合
        assert.equal(armListMsgOf('to', 'A01_nt+B14_pitKey', arms, true), null)
        for (let bad of ['A12_universe', 'A01_nt+A12_universe', 'D31_runawayGuard', 'Z99_none']) {
            assert.equal(armListMsgOf('to', bad, arms, true), FIXED('to', true), bad)
        }
        //目錄本身壞(非陣列、項目非物件)⇒ 一律不合(fail-closed), 不拋
        for (let badArms of [null, undefined, 'x', [null, 1, {}]]) {
            assert.equal(armListMsgOf('rearm', 'A01_nt', badArms), FIXED('rearm'))
        }
        //旗標名只用於訊息
        assert.equal(armListMsgOf('rearm', 'Z', arms), FIXED('rearm'))
    })

    it('--close 0: 離開碼 2、固定訊息、前緣不動、未取鎖(無鎖檔)(原: 轉成數值 0 被當成未給,離開碼 0 而什麼都沒做)', () => {
        let { root, P } = mk()
        let s = { arms: ['A01_nt', 'B14_pitKey'], base: null }
        push(P, s)
        let r = cli(root, ['--close', '0', '--why', '測試'])
        assert.equal(r.status, 2, r.out.join('|'))
        assert.deepEqual(r.out, [FIXED('close')])
        assert.equal(statusOf(P, s), 'proposed')
        assert.equal(fs.existsSync(lockFp(root)), false)
    })

    it('不在臂目錄者一律拒(離開碼 2、固定訊息、前緣不動): 全部不在 / 部分不在(合格之部分亦不結案)/ 空段 / 前後空白 / 大小寫 / 前綴; 訊息不含輸入之臂', () => {
        let { root, P } = mk()
        let s1 = { arms: ['A01_nt', 'B14_pitKey'], base: null }
        let s2 = { arms: ['A04_act'], base: null }
        push(P, s1)
        push(P, s2)
        for (let bad of ['Z99_none', 'A04_act+Z99_none', 'A04_act++B14_pitKey', ' A04_act', 'A04_act ', 'a04_act', 'A04', 'Z99_none+Y98_other']) {
            let r = cli(root, ['--close', bad, '--why', '測試'])
            assert.equal(r.status, 2, `${bad}: ${r.out.join('|')}`)
            assert.deepEqual(r.out, [FIXED('close')], bad)
            for (let piece of bad.split('+').map((x) => x.trim()).filter((x) => x.length > 2)) {
                assert.ok(!r.out.join('\n').includes(piece) && !r.err.includes(piece), `不回顯 ${piece}`)
            }
            assert.deepEqual([statusOf(P, s1), statusOf(P, s2)], ['proposed', 'proposed'], `${bad}: 前緣不動`)
        }
        //空字串之值(旗標給了而值為空)⇒ 拒(原: 當成未給)
        let r0 = cli(root, ['--close', '', '--why', '測試'])
        assert.equal(r0.status, 2, r0.out.join('|'))
        assert.deepEqual([statusOf(P, s1), statusOf(P, s2)], ['proposed', 'proposed'])
    })

    it('--rearm: 原臂不在目錄、目的臂不在目錄、目的臂不可選 ⇒ 離開碼 2、各自之固定訊息(不回顯輸入之臂)、前緣不動; 原: 「臂 <臂> 不在目錄」「前緣內無尚未執行之提案 <臂>」回顯輸入', () => {
        let { root, P } = mk()
        let s = { arms: ['A04_act'], base: null }
        push(P, s)
        for (let [args, want] of [
            [['--rearm', 'Z99_none', '--to', 'A02_ntPit'], FIXED('rearm')],
            [['--rearm', '0', '--to', 'A02_ntPit'], FIXED('rearm')],
            [['--rearm', 'A04_act', '--to', 'Z99_none'], FIXED('to', true)],
            [['--rearm', 'A04_act', '--to', 'A12_universe'], FIXED('to', true)],
            [['--rearm', 'A04_act', '--to', 'A02_ntPit+Z99_none'], FIXED('to', true)],
        ]) {
            let r = cli(root, [...args, '--why', '測試'])
            assert.equal(r.status, 2, `${args.join(' ')}: ${r.out.join('|')}`)
            assert.deepEqual(r.out, [want], args.join(' '))
            assert.equal(statusOf(P, s), 'proposed', args.join(' '))
            assert.equal(fs.existsSync(lockFp(root)), false, '先於取鎖')
        }
    })

    it('--close 並用 --rearm: 任一臂參數不合 ⇒ 兩者皆不執行(離開碼 2、先於取鎖與任何動作); 兩者皆合而前緣無此提案之既有結果不變(結案 0 條)', () => {
        let { root, P } = mk()
        let s1 = { arms: ['A01_nt', 'B14_pitKey'], base: null }
        let s2 = { arms: ['A04_act'], base: null }
        push(P, s1)
        push(P, s2)
        for (let [args, want] of [
            [['--close', 'A01_nt+B14_pitKey', '--rearm', 'Z99_none', '--to', 'A02_ntPit'], FIXED('rearm')],
            [['--close', 'Z99_none', '--rearm', 'A04_act', '--to', 'A02_ntPit'], FIXED('close')],
            [['--close', 'A01_nt+B14_pitKey', '--rearm', 'A04_act', '--to', 'Z99_none'], FIXED('to', true)],
        ]) {
            let r = cli(root, [...args, '--why', '測試'])
            assert.equal(r.status, 2, `${args.join(' ')}: ${r.out.join('|')}`)
            assert.deepEqual(r.out, [want])
            assert.deepEqual([statusOf(P, s1), statusOf(P, s2)], ['proposed', 'proposed'], '全部不動(結案側亦未執行)')
        }
    })

    it('目錄內之臂照舊: 無提案者 ⇒ 結案 0 條(離開碼 0); 有提案者結案 / 改掛成功; 已停用(不可選)之臂之提案仍可結案與改掛(原臂只看是否在目錄)', () => {
        let { root, P } = mk()
        let s = { arms: ['A01_nt', 'B14_pitKey'], base: null }
        push(P, s)
        let r0 = cli(root, ['--close', 'A05_nKeys', '--why', '測試'])
        assert.equal(r0.status, 0, r0.out.join('|'))
        assert.ok(r0.out.includes('結案 0 條'))
        assert.equal(statusOf(P, s), 'proposed', '他臂之結案不動')
        let r1 = cli(root, ['--close', 'B14_pitKey+A01_nt', '--why', '測試'])
        assert.equal(r1.status, 0, r1.out.join('|'))
        assert.ok(r1.out.includes('結案 1 條'))
        assert.equal(statusOf(P, s), 'blocked')
        //已停用之臂(目錄內、不可選): 前緣內尚有其提案者(規格之驗證於推入時,此處直接入前緣模擬升版前已入者)仍須能結案與改掛
        let off = { arms: ['A12_universe'], base: null }
        push(P, off)
        assert.equal(statusOf(P, off), 'proposed', '前提: 不可選之臂之提案在前緣內')
        let r2 = cli(root, ['--close', 'A12_universe', '--why', '測試'])
        assert.equal(r2.status, 0, r2.out.join('|'))
        assert.ok(r2.out.includes('結案 1 條'))
        assert.equal(statusOf(P, off), 'blocked')
        let off2 = { arms: ['A12_universe', 'A04_act'], base: null }
        push(P, off2)
        let r3 = cli(root, ['--rearm', 'A04_act+A12_universe', '--to', 'A02_ntPit', '--why', '測試'])
        assert.equal(r3.status, 0, r3.out.join('|'))
        assert.ok(r3.out.some((l) => l.startsWith('已改掛: ')), r3.out.join('|'))
        assert.equal(statusOf(P, off2), 'blocked')
        assert.equal(statusOf(P, { arms: ['A02_ntPit'], base: null }), 'proposed', '改掛之目的規格入前緣')
    })

    it('臂參數之檢查先於取鎖: 他人持有輪次鎖時,臂不在目錄者仍為離開碼 2(不是 3); 臂合格者為離開碼 3(既有)', () => {
        let { root, P } = mk()
        let s = { arms: ['A04_act'], base: null }
        push(P, s)
        let lk = acquireRunLock(lockFp(root))
        assert.equal(lk.ok, true)
        try {
            let bad = cli(root, ['--close', '0', '--why', '測試'])
            assert.equal(bad.status, 2, bad.out.join('|'))
            assert.deepEqual(bad.out, [FIXED('close')])
            let ok = cli(root, ['--close', 'A04_act', '--why', '測試'])
            assert.equal(ok.status, 3, ok.out.join('|'))
            assert.equal(statusOf(P, s), 'proposed')
        }
        finally {
            lk.release()
        }
    })

    it('原始碼: 臂參數取原字串(argStrOf)、不再以 argOf 讀 close / rearm / to; 對照臂目錄在取鎖之前', () => {
        let src = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'src', 'cli', 'rsi.mjs'), 'utf8')
        for (let k of ['close', 'rearm', 'to']) {
            assert.ok(new RegExp(`argStrOf\\('${k}'`).test(src), `${k}: 取原字串`)
            assert.ok(!new RegExp(`argOf\\('${k}'`).test(src), `${k}: 不以 argOf 讀(數字會被轉型)`)
        }
        let at = (re) => {
            let m = re.exec(src)
            assert.ok(m, String(re))
            return m.index
        }
        assert.ok(at(/armListMsgOf\(nm, v, P\.catalog\.arms, sel\)/) < at(/lockF = takeRoundLockOrExit|lockF = acquireRunLock/), '臂目錄之對照先於取鎖')
    })
})
