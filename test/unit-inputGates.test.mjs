import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import * as CFG from '../src/cfg.mjs'
import { backtestCfg } from '../src/domain/backtestCfg.mjs'
import { setGuardExtra, guardExtraOf, scanTrace, forbiddenPats } from '../src/domain/verify.mjs'
import { mkArm, decideArgsOf } from '../src/domain/armCatalog.mjs'
import { createToolbox } from '../src/arsi/toolbox.mjs'
import { initProject } from '../src/tools/initProject.mjs'
import { makeProjectOrExit } from '../src/domain/domain.mjs'
import { FD_ROOT, makeTmp } from './tools/synthLedger.mjs'
//具名匯出以命名空間取得(修前之複本無此匯出時, 本檔仍可載入, 各案以斷言失敗呈現而非整檔載入失敗)
let { inputMsgOf } = CFG


//安全閘與會使操作與意圖相反者之輸入之檢測(排程第 477 項 ④之餘項 1 ~ 3、7 ~ 10、11 之 scanTrace、12 之 getSettings; R-EV-54 ① ②): 給了而無效 ⇒ 拒絕(固定訊息、不帶輸入值), 不靜默放行、不改用預設
//  跨套件規格〈輸入參數之檢測機制〉: K3 之例外(安全相關 opt 給了而無效即拒絕, §11)、K5(布林與數字不互轉; 字串 'false'、'true'、0、1 皆非布林)、S4(識別字與路徑)、§5.1(失敗通道)、V19、V20
//  規格之句 ⇒ 案: 「給了而無效 ⇒ 拒絕」= 各鍵 × 各無效值之全表(字串 'false'、'true'、數字 0 / 1、空字串、物件、陣列、BigInt…); 「不回顯」= 以祕密字樣為無效之值; 「先於副作用」= 檢查後專案根未建任何檔;
//    「合法輸入之輸出不變」= 合格之寫法之對照(下各 describe 末之案)
let NODE = process.execPath
let SECRET = 'secret-token-xyz'
let BADS = ['false', 'true', 0, 1, '', 'yes', {}, [], [true], -1, NaN, 10n, () => 1]

describe('安全閘與會使操作與意圖相反者之輸入之檢測(R-EV-54 ① ②)', function () {
    this.timeout(300000)
    let t = makeTmp('inputGates')
    after(() => t.cleanup())
    let settingsOf = (mod = (s) => s) => mod(JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8')))
    let mkRoot = (name, mod) => {
        let dir = path.join(t.dir, name)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settingsOf(mod), null, 1), 'utf8')
        return dir
    }
    let run = (rel, args, dir, env = {}) => {
        let r = spawnSync(NODE, [path.join(FD_ROOT, rel), ...args], { cwd: dir, env: { ...process.env, ARSI_ROOT: dir, ...env }, encoding: 'utf8', windowsHide: true })
        return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() }
    }
    //throwsMsg, 斷言拋出之訊息恰為固定訊息且不含祕密字樣
    let throwsMsg = (fn, want, label) => {
        let err = null
        try {
            fn()
        }
        catch (e) {
            err = e
        }
        assert.ok(err !== null, `${label}: 應拋`)
        assert.strictEqual(String(err.message), want, label)
        assert.ok(!String(err.message).includes(SECRET), `${label}: 不回顯`)
    }

    describe('保留期之門(g_build.mjs; periods.holdoutFrom、帳本終點)', () => {
        let want = (key) => `ERROR invalid ${key}: must be a time string such as 2024-01-01T00:00:00`
        it('periods.holdoutFrom 給了而無效(非字串、不可解析之字串)⇒ 離開碼 2、固定訊息、未建任何帳本夾(原: NaN 使「終點已進入保留期」恆假而照建)', () => {
            let n = 0
            for (let v of ['not-a-time', SECRET, '', 5, true, {}, [], 'false', '2026-13-45T00:00:00', '2026-02-30T00:00:00', '2026-08-01T24:00:00', '2026-08-01T00:00:00Z', '2026-08-01']) {
                let dir = mkRoot(`ho${n++}`, (s) => ({ ...s, periods: { ...s.periods, holdoutFrom: v } }))
                let r = run('src/cli/build.mjs', [], dir)
                assert.strictEqual(r.code, 2, `holdoutFrom ${typeof v}: 離開碼 ${r.code} ${r.err.slice(0, 160)}`)
                assert.strictEqual(r.out, want('periods.holdoutFrom'), `holdoutFrom ${typeof v}`)
                assert.deepEqual(fs.readdirSync(dir), ['settings.json'], '未建任何檔')
            }
            assert(n >= 13, `案數 ${n}`)
        })
        it('帳本終點(回測期終點、--train 時訓練期終點)給了而無效 ⇒ 同(門檻較之兩端皆須為時間)', () => {
            let a = mkRoot('end1', (s) => ({ ...s, periods: { ...s.periods, backtest: { ...s.periods.backtest, end: 'abc' } } }))
            let r = run('src/cli/build.mjs', [], a)
            assert.strictEqual(r.code, 2)
            assert.strictEqual(r.out, want('periods.backtest.end'))
            let b = mkRoot('end2', (s) => ({ ...s, periods: { ...s.periods, train: { ...s.periods.train, end: 7 } } }))
            let r2 = run('src/cli/build.mjs', ['--train'], b)
            assert.strictEqual(r2.code, 2)
            assert.strictEqual(r2.out, want('periods.train.end'))
            assert.deepEqual(fs.readdirSync(b), ['settings.json'])
        })
        it('合法輸入之行為不變: 終點已進入保留期 ⇒ 既有之 ERROR 訊息與離開碼 2; 未給保留期起點(undefined 或 null)⇒ 無此門(不報 invalid periods.holdoutFrom)', () => {
            let a = mkRoot('okho1', (s) => ({ ...s, periods: { ...s.periods, holdoutFrom: s.periods.backtest.end } }))
            let r = run('src/cli/build.mjs', [], a)
            assert.strictEqual(r.code, 2)
            //排程第 611 項 ②: 訊息不帶時間(K9; 原: `ERROR 帳本終點 <時間> 已進入保留期(<時間> 起);不建`)
            assert.equal(r.out, 'ERROR 帳本終點已進入保留期;不建', r.out)
            assert(!/\d{4}-\d{2}-\d{2}/.test(r.out), '不帶設定檔之時間')
            for (let v of [undefined, null]) {
                let b = mkRoot(`okho2${v === null ? 'n' : 'u'}`, (s) => {
                    let p = { ...s.periods, holdoutFrom: v }
                    if (v === undefined) {
                        delete p.holdoutFrom
                    }
                    return { ...s, periods: p }
                })
                let r2 = run('src/cli/build.mjs', [], b)
                assert(!/invalid periods\.holdoutFrom/.test(r2.out + r2.err), `未給 ${String(v)}: 不報保留期之門`)
            }
        })
    })

    describe('禁區字樣之來源(guard.forbidden、source.libraryRoot; setGuardExtra、guardExtraOf)', () => {
        let FB = 'invalid guard.forbidden: must be an array of { pattern, label }'
        let ITEM = (i) => `invalid guard.forbidden[${i}]: must be an object { pattern, label } with a non-empty string label and a pattern that is a valid regular expression (non-empty string or RegExp)`
        it('guardExtraOf: source.libraryRoot 給了而不是非空字串 ⇒ 拋 invalid source.libraryRoot: must be a non-empty string; guard 給了而不是一般物件 ⇒ 拋 invalid guard: must be an object; guard.forbidden 給了而不是陣列 ⇒ 拋', () => {
            for (let v of [5, '', {}, [], true, 10n]) {
                throwsMsg(() => guardExtraOf({ FD_ROOT, source: { libraryRoot: v } }), 'invalid source.libraryRoot: must be a non-empty string', `libraryRoot ${typeof v}`)
            }
            for (let v of ['x', 5, [], true]) {
                throwsMsg(() => guardExtraOf({ FD_ROOT, guard: v }), 'invalid guard: must be an object', `guard ${typeof v}`)
            }
            for (let v of ['x', 5, {}, true, SECRET]) {
                throwsMsg(() => guardExtraOf({ FD_ROOT, guard: { forbidden: v } }), FB, `forbidden ${typeof v}`)
            }
        })
        it('guard.forbidden 之項: 非一般物件、缺 label 或 label 為空白 / 非字串、缺 pattern 或 pattern 為空 / 非字串、非法之正規式 ⇒ 拋 invalid guard.forbidden[i](i = 該項之索引); 不回顯樣式之內容', () => {
            let bad = [[1], ['a'], [null], [[]], [{ label: 'x' }], [{ pattern: '', label: 'x' }], [{ pattern: 5, label: 'x' }], [{ pattern: {}, label: 'x' }], [{ pattern: 'a' }], [{ pattern: 'a', label: '' }], [{ pattern: 'a', label: '  ' }], [{ pattern: 'a', label: 5 }], [{ pattern: `(${SECRET}`, label: 'x' }], [{ pattern: '[', label: 'x' }]]
            for (let items of bad) {
                throwsMsg(() => guardExtraOf({ FD_ROOT, guard: { forbidden: items } }), ITEM(0), JSON.stringify(items).replace(SECRET, '(secret)'))
                throwsMsg(() => setGuardExtra(items), ITEM(0).replace('guard.forbidden', 'items'), `setGuardExtra ${JSON.stringify(items).replace(SECRET, '(secret)')}`)
            }
            //索引為該項之位置(前面合格者之後)
            throwsMsg(() => guardExtraOf({ FD_ROOT, guard: { forbidden: [{ pattern: 'ok', label: 'L' }, { pattern: 'ok2', label: 'L2' }, { label: 'x' }] } }), ITEM(2), '第 3 項')
            throwsMsg(() => setGuardExtra('x'), 'invalid items: must be an array of { pattern, label }', 'setGuardExtra 非陣列')
        })
        it('無效時模組層狀態不變(先於任何改變): setGuardExtra 之無效輸入不清掉既有之禁區字樣', () => {
            try {
                assert.strictEqual(setGuardExtra([{ pattern: 'zone-keep', label: '保留' }]), 1)
                let n0 = forbiddenPats('p').length
                throwsMsg(() => setGuardExtra([{ pattern: 'new-one', label: 'N' }, { label: 'bad' }]), ITEM(1).replace('guard.forbidden', 'items'), '第二項無效')
                assert.strictEqual(forbiddenPats('p').length, n0, '禁區字樣之數不變')
                assert(forbiddenPats('p').some(([re]) => re.test('zone-keep')), '原有者仍在')
                assert(!forbiddenPats('p').some(([re]) => re.test('new-one')), '無效之批不部分生效')
            }
            finally {
                setGuardExtra([])
            }
        })
        it('合法輸入之行為不變: 未給(undefined、null、{}、空陣列)⇒ 無; 合格之項照加(RegExp 與字串之樣式); 策略庫在專案夾外 ⇒ 列「策略庫專案」', () => {
            assert.deepEqual(guardExtraOf({}), [])
            assert.deepEqual(guardExtraOf({ FD_ROOT, source: { libraryRoot: null }, guard: null }), [])
            assert.deepEqual(guardExtraOf({ FD_ROOT, guard: { forbidden: [] } }), [])
            assert.deepEqual(guardExtraOf({ FD_ROOT, guard: { forbidden: null } }), [])
            assert.deepEqual(guardExtraOf({ FD_ROOT, source: { libraryRoot: 'D:/demo-strategy-lib/data' }, guard: { forbidden: [{ pattern: 'zone', label: ' 區 ' }] } }), [{ pattern: 'demo-strategy-lib', label: '策略庫專案' }, { pattern: 'zone', label: '區' }])
            try {
                assert.strictEqual(setGuardExtra([{ pattern: /zz_secret/g, label: '另加字樣' }, { pattern: 'a.b', label: 'B' }]), 2)
                assert.strictEqual(setGuardExtra(undefined), 0)
                assert.strictEqual(setGuardExtra(null), 0)
            }
            finally {
                setGuardExtra([])
            }
        })
        it('入口: g_toolbox.mjs 與 tools/scanCheck.mjs 遇設定不合 ⇒ ERROR <固定訊息>、離開碼 2(不寫任何檔); 設定合格者照常', () => {
            for (let [rel, args] of [['src/cli/toolbox.mjs', []], ['src/tools/scanCheck.mjs', []]]) {
                for (let [mod, msg] of [
                    [(s) => ({ ...s, guard: { forbidden: [{ pattern: 'ok', label: '' }] } }), ITEM(0)],
                    [(s) => ({ ...s, source: { ...s.source, libraryRoot: 5 } }), 'invalid source.libraryRoot: must be a non-empty string'],
                    [(s) => ({ ...s, guard: 'x' }), 'invalid guard: must be an object'],
                ]) {
                    let dir = mkRoot(`guardEntry_${path.basename(rel, '.mjs')}_${Math.random().toString(36).slice(2, 6)}`, mod)
                    let r = run(rel, args, dir)
                    assert.strictEqual(r.code, 2, `${rel}: 離開碼 ${r.code} ${r.err.slice(0, 160)}`)
                    assert.strictEqual(r.out, `ERROR ${msg}`, rel)
                    assert.deepEqual(fs.readdirSync(dir), ['settings.json'], `${rel}: 未建任何檔`)
                }
            }
            //合格者: scanCheck 於空樹(僅需 nodeDir)照常
            let ok = mkRoot('guardOk', (s) => ({ ...s, guard: { forbidden: [{ pattern: 'zone', label: '區' }] } }))
            fs.mkdirSync(path.join(ok, 'rsi', 'records', 'nodes'), { recursive: true })
            let r = run('src/tools/scanCheck.mjs', [], ok)
            assert.strictEqual(r.code, 0, `${r.out} ${r.err.slice(0, 160)}`)
            assert(/與節點文件不同者 0 份/.test(r.out), r.out)
        })
        it('inputMsgOf: 認得 invalid guard.…、guard:、source.libraryRoot、rsi.rankBy、settings.…(單行), 其餘回 null(照舊拋出); 不認得評估器之前綴(那是 configMsgOf 之事)', () => {
            assert(typeof inputMsgOf === 'function', '有 inputMsgOf')
            for (let m of ['invalid guard.forbidden: must be x', 'invalid guard: must be an object', 'invalid source.libraryRoot: must be a non-empty string', 'invalid rsi.rankBy: must be one of content, key', 'invalid settings.eval: must be an object', 'invalid settings: must be an object', 'invalid backtest: must be an object']) {
                assert.strictEqual(inputMsgOf(new Error(m)), m)
            }
            assert.strictEqual(inputMsgOf(new Error('invalid guard.x: y\nsecond line')), 'invalid guard.x: y', '取第一行')
            for (let m of ['invalid eval.nullDraws: must be x', 'invalid periods.train.end: x', 'boom', 'invalid sourcexlibraryRoot', 'invalid backtest.enabled: must be a boolean']) {
                assert.strictEqual(inputMsgOf(new Error(m)), null, m)
            }
            assert.strictEqual(inputMsgOf(undefined), null)
        })
    })

    describe('makeProjectOrExit: rsi.rankBy(決定「最高」與補位之底之口徑)與設定之辨識', () => {
        let mkSt = (rsiExtra = {}, more = {}) => {
            let st = CFG.getSettings()
            let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
            st.resources = {}
            st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), docLimits: false, autoFill: false, ...rsiExtra }
            st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
            st.eval.ledgerDir = path.join(d, 'ledger')
            fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
            fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthIG' }), 'utf8')
            return { ...st, ...more }
        }
        //exitOf, 攔截 console.log 與 process.exit: 回 { out, code }(未呼叫 exit 者 code 為 null)
        let exitOf = (fn) => {
            let logs = []
            let log0 = console.log
            let exit0 = process.exit
            console.log = (...a) => logs.push(a.join(' '))
            process.exit = (c) => {
                throw Object.assign(new Error('EXIT'), { exitCode: c })
            }
            try {
                fn()
                return { out: logs.join('\n'), code: null }
            }
            catch (e) {
                if (e && e.message === 'EXIT') {
                    return { out: logs.join('\n'), code: e.exitCode }
                }
                throw e
            }
            finally {
                console.log = log0
                process.exit = exit0
            }
        }
        let inject = () => ({ dispatch: async () => ({ ok: false, error: 'fake' }), gate: null })

        it('rsi.rankBy 給了而不是 content 或 key(如 Content、contents、true、1、空字串、物件)⇒ ERROR invalid rsi.rankBy: must be one of content, key、離開碼 2(原: 靜默視為排序鍵)', () => {
            for (let v of ['Content', 'contents', ' content', true, 1, '', {}, [], SECRET]) {
                let r = exitOf(() => makeProjectOrExit(mkSt({ rankBy: v }), inject()))
                assert.strictEqual(r.code, 2, `rankBy ${typeof v}`)
                assert.strictEqual(r.out, 'ERROR invalid rsi.rankBy: must be one of content, key', `rankBy ${typeof v}`)
                assert.ok(!r.out.includes(SECRET), '不回顯')
            }
        })
        it('settings.agents 未給(undefined、null)⇒ 組裝成功(唯讀之工具與模式照常); 給了而不合者組裝時印 ERROR invalid settings.agents…、離開碼 2(注入派工函數者不檢)', async () => {
            //技能根下之替身派工套件(makeDispatch 於建構時載入之; 不依賴本機之技能根)
            let skills = path.join(t.dir, 'skills_stub')
            fs.mkdirSync(path.join(skills, 'node_modules', 'w-dispatch-ai'), { recursive: true })
            fs.writeFileSync(path.join(skills, 'node_modules', 'w-dispatch-ai', 'package.json'), JSON.stringify({ name: 'w-dispatch-ai', main: 'index.js' }), 'utf8')
            fs.writeFileSync(path.join(skills, 'node_modules', 'w-dispatch-ai', 'index.js'), 'module.exports = { providers: [], readEnvFile: () => ({}) }\n', 'utf8')
            let withSkills = (st) => ({ ...st, dispatch: { ...st.dispatch, skillsRoot: skills } })
            for (let v of [undefined, null]) {
                let P = makeProjectOrExit({ ...withSkills(mkSt()), agents: v }, { gate: null })
                assert.strictEqual(typeof P.rsi.init, 'function', `agents ${String(v)}: 組裝成功`)
            }
            let st2 = withSkills(mkSt())
            st2.agents = { node: { kind: 'codex' } }
            let r = exitOf(() => makeProjectOrExit(st2, { gate: null }))
            assert.strictEqual(r.code, 2)
            assert.strictEqual(r.out, 'ERROR invalid settings.agents.node.kind: must be one of opencode, claude')
            //注入派工函數者不檢查(不用 agents)
            let st3 = mkSt()
            st3.agents = { node: { kind: 'codex' } }
            assert.doesNotThrow(() => makeProjectOrExit(st3, { dispatch: async () => ({ ok: false }), gate: null }))
        })
        it('rsi.rankBy 為 content、key、未給(undefined、null)⇒ 組裝成功(合法輸入之行為不變); P.rankBy 為 content 或 key', () => {
            for (let [v, want] of [['content', 'content'], ['key', 'key'], [undefined, 'key'], [null, 'key']]) {
                let r = exitOf(() => {
                    let P = makeProjectOrExit(mkSt({ rankBy: v }), inject())
                    assert.strictEqual(P.rankBy, want, `rankBy ${String(v)}`)
                })
                assert.strictEqual(r.code, null, `rankBy ${String(v)}: ${r.out}`)
            }
        })
        it('guard.forbidden、source.libraryRoot 之不合(makeProject 內之 setGuardExtra(guardExtraOf(st))): makeProjectOrExit 印 ERROR、離開碼 2', () => {
            let r = exitOf(() => makeProjectOrExit(mkSt({}, { guard: { forbidden: [{ pattern: 'x' }] } }), inject()))
            assert.strictEqual(r.code, 2)
            assert.strictEqual(r.out, `ERROR ${ITEM_0()}`)
            let r2 = exitOf(() => makeProjectOrExit(mkSt({}, { source: { ...CFG.getSettings().source, libraryRoot: 7 } }), inject()))
            assert.strictEqual(r2.code, 2)
            assert.strictEqual(r2.out, 'ERROR invalid source.libraryRoot: must be a non-empty string')
        })
        let ITEM_0 = () => 'invalid guard.forbidden[0]: must be an object { pattern, label } with a non-empty string label and a pattern that is a valid regular expression (non-empty string or RegExp)'
    })

    describe('settings.backtest 之布林(enabled、grade.enabled、grade.matchSides; K5)與 rule、grade 之節', () => {
        it('給了而不是 true / false(字串 false、true、數字 0、1、空字串、物件、陣列、BigInt、函數、NaN)⇒ 拋 invalid backtest.<鍵>: must be a boolean(原: enabled 以 !== false 判而 "false"、0 仍啟用; grade.enabled 之 null 展開覆蓋使分級關閉、"false" 仍啟用; matchSides 之 "true" 使 === true 為假)', () => {
            for (let [mk, key] of [
                [(v) => ({ backtest: { enabled: v } }), 'backtest.enabled'],
                [(v) => ({ backtest: { grade: { enabled: v } } }), 'backtest.grade.enabled'],
                [(v) => ({ backtest: { grade: { matchSides: v } } }), 'backtest.grade.matchSides'],
            ]) {
                for (let v of BADS) {
                    throwsMsg(() => backtestCfg(mk(v)), `invalid ${key}: must be a boolean`, `${key} ${typeof v === 'bigint' ? 'BigInt' : JSON.stringify(v)}`)
                }
                //有 grade.enabled 之 null(JSON 之 null 視為未給 ⇒ 預設)與 undefined ⇒ 預設
                for (let v of [undefined, null]) {
                    assert.doesNotThrow(() => backtestCfg(mk(v)), `${key} ${String(v)} 為未給`)
                }
            }
            throwsMsg(() => backtestCfg({ backtest: { enabled: SECRET } }), 'invalid backtest.enabled: must be a boolean', '不回顯')
        })
        it('rule、grade 給了而不是一般物件(字串、數字、布林、陣列)⇒ 拋 invalid backtest.rule / grade: must be an object(原: 靜默視為空物件 ⇒ grade: "false" 之分級照常啟用); 未給(undefined、null)= 空物件', () => {
            for (let v of ['false', 5, true, [], [1], () => 1]) {
                throwsMsg(() => backtestCfg({ backtest: { rule: v } }), 'invalid backtest.rule: must be an object', `rule ${JSON.stringify(v)}`)
                throwsMsg(() => backtestCfg({ backtest: { grade: v } }), 'invalid backtest.grade: must be an object', `grade ${JSON.stringify(v)}`)
            }
            for (let v of [undefined, null, {}]) {
                assert.doesNotThrow(() => backtestCfg({ backtest: { rule: v, grade: v } }))
            }
        })
        it('合法輸入之輸出不變: 布林 true / false 之 2 × 2 × 2 組合; 預設 = 啟用、分級啟用、matchSides true; grade 之鍵序為 enabled、pAbove、pBelow、pStrong、splits、matchSides、其餘; 未知之鍵照舊展開', () => {
            let want = (e, ge, ms) => ({ enabled: e, grade: { enabled: ge, matchSides: ms } })
            for (let e of [true, false]) {
                for (let ge of [true, false]) {
                    for (let ms of [true, false]) {
                        let c = backtestCfg({ backtest: { enabled: e, grade: { enabled: ge, matchSides: ms } } })
                        assert.strictEqual(c.enabled, want(e, ge, ms).enabled)
                        assert.strictEqual(c.grade.enabled, ge)
                        assert.strictEqual(c.grade.matchSides, ms)
                    }
                }
            }
            let d = backtestCfg({})
            assert.strictEqual(d.enabled, true)
            assert.strictEqual(d.grade.enabled, true)
            assert.strictEqual(d.grade.matchSides, true)
            assert.deepEqual(Object.keys(d.grade), ['enabled', 'pAbove', 'pBelow', 'pStrong', 'splits', 'matchSides'])
            let x = backtestCfg({ backtest: { grade: { enabled: false, foo: 1, matchSides: false }, rule: { bar: 2 } } })
            assert.deepEqual(Object.keys(x.grade), ['enabled', 'pAbove', 'pBelow', 'pStrong', 'splits', 'matchSides', 'foo'])
            assert.strictEqual(x.grade.foo, 1)
            assert.deepEqual(Object.keys(x.rule), ['meanMin', 'worstPhaseMin', 'bar'])
        })
        it('settings.backtest 本身給了而不是一般物件(false、字串、數字、陣列)⇒ 拋 invalid backtest: must be an object(原: `|| {}` 靜默視為空物件而回測期旗標照常啟用, 與寫 false 以求關閉之意圖相反); 路徑欄 privateRoot、ledgerDir、resultDir 給了而非非空字串(空字串、false、0、數字、物件、陣列)⇒ 拋 invalid backtest.<鍵>: must be a non-empty string(原: 空字串等靜默取預設、其餘為原生 TypeError); 未給(undefined、null)= 預設', () => {
            for (let v of [false, true, 'false', 'x', 0, 5, [], [1], () => 1]) {
                throwsMsg(() => backtestCfg({ backtest: v }), 'invalid backtest: must be an object', `backtest ${typeof v === 'function' ? 'fn' : JSON.stringify(v)}`)
            }
            for (let k of ['privateRoot', 'ledgerDir', 'resultDir']) {
                for (let v of ['', false, 0, 5, true, {}, [], SECRET.length]) {
                    throwsMsg(() => backtestCfg({ backtest: { [k]: v } }), `invalid backtest.${k}: must be a non-empty string`, `${k} ${JSON.stringify(v)}`)
                }
                for (let v of [undefined, null]) {
                    assert.doesNotThrow(() => backtestCfg({ backtest: { [k]: v } }), `${k} ${String(v)} = 預設`)
                }
            }
            for (let v of [undefined, null]) {
                assert.doesNotThrow(() => backtestCfg({ backtest: v }))
            }
            let c = backtestCfg({ backtest: { privateRoot: path.join(t.dir, 'pr'), ledgerDir: path.join(t.dir, 'lg') } })
            assert.strictEqual(c.privateRoot, path.resolve(t.dir, 'pr'))
            assert.strictEqual(c.ledgerDir, path.resolve(t.dir, 'lg'))
            assert.strictEqual(c.resultDir, path.join(path.resolve(t.dir, 'pr'), 'backtest'), 'resultDir 未給 = 私有根下之預設')
        })
        it('入口: tools/scanCheck.mjs 與 g_toolbox.mjs(以 backtestCfg 取私有根)遇 settings.backtest 不為物件 ⇒ ERROR invalid backtest: must be an object、離開碼 2(inputMsgOf 認得 invalid backtest:)', () => {
            for (let rel of ['src/tools/scanCheck.mjs', 'src/cli/toolbox.mjs']) {
                let dir = mkRoot(`btSect_${path.basename(rel, '.mjs')}`, (s) => ({ ...s, backtest: false }))
                fs.mkdirSync(path.join(dir, 'rsi', 'records', 'nodes'), { recursive: true })
                let r = run(rel, [], dir)
                assert.strictEqual(r.code, 2, `${rel}: 離開碼 ${r.code} ${r.err.slice(0, 160)}`)
                assert.strictEqual(r.out, 'ERROR invalid backtest: must be an object', rel)
            }
        })
        it('入口: tools/scanCheck.mjs(以 backtestCfg 取私有根)遇不合 ⇒ ERROR invalid backtest.<鍵>: must be a boolean、離開碼 2(configMsgOf 認得 invalid backtest.)', () => {
            let n = 0
            for (let [mod, msg] of [
                [(s) => ({ ...s, backtest: { ...s.backtest, enabled: 'false' } }), 'invalid backtest.enabled: must be a boolean'],
                [(s) => ({ ...s, backtest: { ...s.backtest, grade: { enabled: 0 } } }), 'invalid backtest.grade.enabled: must be a boolean'],
                [(s) => ({ ...s, backtest: { ...s.backtest, grade: { matchSides: 'true' } } }), 'invalid backtest.grade.matchSides: must be a boolean'],
            ]) {
                let dir = mkRoot(`btEntry${n++}`, mod)
                fs.mkdirSync(path.join(dir, 'rsi', 'records', 'nodes'), { recursive: true })
                let r = run('src/tools/scanCheck.mjs', [], dir)
                assert.strictEqual(r.code, 2, `${msg}: 離開碼 ${r.code} ${r.err.slice(0, 160)}`)
                assert.strictEqual(r.out, `ERROR ${msg}`)
            }
        })
    })

    describe('createToolbox(共用工具區之規則 = 安全閘)', () => {
        let dirOf = () => path.join(t.dir, `tb_${Math.random().toString(36).slice(2, 8)}`)
        it('opt 非一般物件 ⇒ 拋 invalid opt: must be an object(原: null 為原生 TypeError); dir 非非空字串 ⇒ 拋 invalid opt.dir: must be a non-empty string; 先於任何副作用(未建資料夾)', () => {
            for (let v of [null, undefined, 'x', 5, [], () => 1]) {
                throwsMsg(() => createToolbox(v), 'invalid opt: must be an object', `opt ${String(v)}`)
            }
            for (let v of [undefined, null, '', 5, {}, [], true]) {
                throwsMsg(() => createToolbox({ dir: v }), 'invalid opt.dir: must be a non-empty string', `dir ${typeof v}`)
            }
            let d = dirOf()
            throwsMsg(() => createToolbox({ dir: d, maxFiles: 'abc' }), 'invalid opt.maxFiles: must be a positive integer', 'maxFiles')
            assert.ok(!fs.existsSync(d), '未建資料夾')
        })
        it('maxFileBytes、maxFiles 給了而無效(abc、0、小數、負數、布林、空字串、物件、BigInt)⇒ 拋 invalid opt.<鍵>: must be a positive integer(原: \'abc\' ⇒ 大小限制失效; null ⇒ 全檔被還原)', () => {
            for (let k of ['maxFileBytes', 'maxFiles']) {
                for (let v of ['abc', 0, '0', 2.5, -1, true, false, '', {}, [], 10n, NaN, Infinity, SECRET]) {
                    throwsMsg(() => createToolbox({ dir: dirOf(), [k]: v }), `invalid opt.${k}: must be a positive integer`, `${k} ${typeof v === 'bigint' ? 'BigInt' : JSON.stringify(v)}`)
                }
            }
        })
        it('其餘之規則項給了而無效 ⇒ 拋: checkFile、checkIndex、codeOf 非函數(原: 靜默不檢查)、exts 非字串陣列、indexFile 非非空字串或含路徑分隔、indexSeed 非字串、baselineFile 非非空字串', () => {
            for (let k of ['checkFile', 'checkIndex', 'codeOf']) {
                for (let v of ['x', 5, true, {}, []]) {
                    throwsMsg(() => createToolbox({ dir: dirOf(), [k]: v }), `invalid opt.${k}: must be a function`, `${k} ${typeof v}`)
                }
            }
            for (let v of ['.mjs', 5, [1], [null], {}, true]) {
                throwsMsg(() => createToolbox({ dir: dirOf(), exts: v }), 'invalid opt.exts: must be an array of strings', `exts ${JSON.stringify(v)}`)
            }
            for (let v of ['', 5, {}]) {
                throwsMsg(() => createToolbox({ dir: dirOf(), indexFile: v }), 'invalid opt.indexFile: must be a non-empty string', `indexFile ${typeof v}`)
            }
            for (let v of ['../x.md', 'a/b.md', 'a\\b.md', '..', '.']) {
                throwsMsg(() => createToolbox({ dir: dirOf(), indexFile: v }), 'invalid opt.indexFile: must be a file name without path separators', `indexFile ${v}`)
            }
            for (let v of [5, {}, true, []]) {
                throwsMsg(() => createToolbox({ dir: dirOf(), indexSeed: v }), 'invalid opt.indexSeed: must be a string', `indexSeed ${typeof v}`)
            }
            for (let v of ['', 5, {}]) {
                throwsMsg(() => createToolbox({ dir: dirOf(), baselineFile: v }), 'invalid opt.baselineFile: must be a non-empty string', `baselineFile ${typeof v}`)
            }
        })
        it('合法輸入之行為不變: 未給(undefined、null)取預設; 數字字串轉為數值後使用(單檔上限 \'20\' ⇒ 超過 20 位元組者被還原); 函數與字串之項照用', () => {
            let d = dirOf()
            let tb = createToolbox({ dir: d, indexSeed: 'snippets/ok.mjs snippets/big.mjs', maxFileBytes: '20', maxFiles: ' 5 ', checkFile: null, checkIndex: undefined, codeOf: null, baselineFile: null, exts: undefined, indexFile: null })
            let snap = tb.snapshot()
            fs.mkdirSync(path.join(d, 'snippets'), { recursive: true })
            fs.writeFileSync(path.join(d, 'snippets', 'ok.mjs'), '// ok\n', 'utf8')
            fs.writeFileSync(path.join(d, 'snippets', 'big.mjs'), `// ${'x'.repeat(60)}\n`, 'utf8')
            let r = tb.check(snap)
            assert.deepEqual(r.reverted.map((x) => x.rel), ['snippets/big.mjs'], '超過上限者被還原')
            assert(fs.existsSync(path.join(d, 'snippets', 'ok.mjs')) && !fs.existsSync(path.join(d, 'snippets', 'big.mjs')))
            //預設之上限(200 KB、200 檔)不因未給而變成 0
            let tb2 = createToolbox({ dir: dirOf(), indexSeed: 'a.mjs' })
            let s2 = tb2.snapshot()
            fs.writeFileSync(path.join(tb2.dir, 'a.mjs'), '// a\n', 'utf8')
            assert.strictEqual(tb2.check(s2).reverted.length, 0)
        })
    })

    describe('initProject(寫入專案根; dry、force、root)', () => {
        it('opt 非一般物件 ⇒ 拋 invalid opt: must be an object; root 給了而非非空字串 ⇒ 拋 invalid opt.root: must be a non-empty string; dry、force 給了而不是 true / false ⇒ 拋 invalid opt.<鍵>: must be a boolean; 未寫任何檔', () => {
            let d = path.join(t.dir, 'initEmpty')
            fs.mkdirSync(d, { recursive: true })
            for (let v of ['x', 5, [], () => 1]) {
                throwsMsg(() => initProject(v), 'invalid opt: must be an object', `opt ${typeof v}`)
            }
            for (let v of ['', 5, {}, [], true]) {
                throwsMsg(() => initProject({ root: v }), 'invalid opt.root: must be a non-empty string', `root ${typeof v}`)
            }
            for (let k of ['dry', 'force']) {
                for (let v of ['false', 'true', 0, 1, '', {}, [], 'no']) {
                    throwsMsg(() => initProject({ root: d, [k]: v }), `invalid opt.${k}: must be a boolean`, `${k} ${JSON.stringify(v)}`)
                }
            }
            throwsMsg(() => initProject({ root: d, dry: SECRET }), 'invalid opt.dry: must be a boolean', '不回顯')
            assert.deepEqual(fs.readdirSync(d), [], '未寫任何檔')
        })
        it('合法輸入之行為不變: dry: true 列出將寫入之檔而不寫; dry、force 為 false 或未給(undefined、null)⇒ 寫入; opt 為 null 或 undefined ⇒ 視為 {}(root 取環境變數或工作目錄, 此處不跑)', () => {
            let d = path.join(t.dir, 'initDry')
            fs.mkdirSync(d, { recursive: true })
            let r = initProject({ root: d, dry: true })
            assert(r.written.length > 0 && r.written.includes('settings.json'), '列出將寫入之檔')
            assert.deepEqual(fs.readdirSync(d), [], 'dry 未寫任何檔')
            let d2 = path.join(t.dir, 'initReal')
            fs.mkdirSync(d2, { recursive: true })
            let r2 = initProject({ root: d2, dry: false, force: null })
            assert(r2.written.includes('settings.json') && fs.existsSync(path.join(d2, 'settings.json')), '實寫')
            assert.deepEqual(initProject({ root: d2, dry: undefined, force: undefined }).written, [], '第二次無變更')
        })
    })

    describe('decideArgsOf、mkArm(臂目錄之審定)', () => {
        let catalog = () => ({ layers: { A: '層 A' }, arms: [{ id: 'A01_nt', n: 1, layer: 'A', title: 'nt', selectable: true, status: 'proposed' }] })
        let pNew = { id: 'P001', kind: 'new', title: '示範', mechanism: '說明', layer: 'A' }
        it('accept、selectable、noGrid 給了而不是 true / false(字串 true、false、數字 0、1、空字串)⇒ 回 { error: invalid opt.<鍵>: must be a boolean }(未產出審定參數; 原: accept 字串 true ⇒ 引擎不採、selectable 字串 false ⇒ 可選)', () => {
            for (let k of ['accept', 'selectable', 'noGrid']) {
                for (let v of ['true', 'false', 0, 1, '', {}, [], 'yes']) {
                    let r = decideArgsOf(pNew, { accept: true, why: 'w', name: 'k', catalog: catalog(), [k]: v })
                    assert.deepEqual(r, { error: `invalid opt.${k}: must be a boolean` }, `${k} ${JSON.stringify(v)}`)
                }
            }
            let s = decideArgsOf(pNew, { accept: SECRET, why: 'w' })
            assert.deepEqual(s, { error: 'invalid opt.accept: must be a boolean' })
            assert.ok(!JSON.stringify(s).includes(SECRET), '不回顯')
            assert.deepEqual(decideArgsOf(pNew, 'x'), { error: 'invalid opt: must be an object' })
            assert.deepEqual(decideArgsOf(pNew, 5), { error: 'invalid opt: must be an object' })
        })
        it('未給(undefined、null)⇒ accept false(不採)、selectable 預設可選、noGrid false; opt 為 null 或 undefined ⇒ {}; 合法之布林照舊', () => {
            assert.deepEqual(decideArgsOf(pNew, null), { args: { accept: false, why: undefined, by: '主控' } })
            assert.deepEqual(decideArgsOf(pNew, undefined), { args: { accept: false, why: undefined, by: '主控' } })
            assert.deepEqual(decideArgsOf(pNew, { accept: null, why: 'w' }).args, { accept: false, why: 'w', by: '主控' })
            let a = decideArgsOf(pNew, { accept: true, why: 'w', name: 'k', selectable: null, noGrid: null, catalog: catalog() }).args.arm
            assert.strictEqual(a.selectable, true, 'selectable null = 預設可選')
            let b = decideArgsOf(pNew, { accept: true, why: 'w', name: 'k', selectable: false, catalog: catalog() }).args.arm
            assert.strictEqual(b.selectable, false)
        })
        it('修訂(revise)之可選與否之變更不依 ARM_ID 之格式(臂 id 取自現行目錄之既有臂; 複審 #12): 目錄內 id 不合格式者仍可改可選與否、落成名依其 id', () => {
            let cat = { layers: { A: 'x' }, arms: [{ id: 'weird-id', n: 1, layer: 'A', title: 't', selectable: true }, { id: 'A01_off', n: 2, layer: 'A', title: 'o', selectable: false }] }
            let off = decideArgsOf({ id: 'P9', kind: 'revise', arm: 'weird-id', mechanism: 'm' }, { accept: true, why: 'w', selectable: false, catalog: cat })
            assert.deepEqual(off.args.arm, { desc: 'm', selectable: false, realize: [{ kind: 'manual', how: '不派給節點(量尺 / 迴圈自身 / 須改評估器)' }] })
            let on = decideArgsOf({ id: 'P9', kind: 'revise', arm: 'A01_off', mechanism: 'm' }, { accept: true, why: 'w', selectable: true, catalog: cat })
            assert.deepEqual(on.args.arm, { desc: 'm', selectable: true, realize: [{ kind: 'operator', op: 'add:A01_off' }, { kind: 'carrier', name: 'A01_off' }] })
            //可選與否未變者不帶 selectable、realize
            assert.deepEqual(decideArgsOf({ id: 'P9', kind: 'revise', arm: 'weird-id', mechanism: 'm' }, { accept: true, why: 'w', selectable: true, catalog: cat }).args.arm, { desc: 'm' })
        })
        it('mkArm: opt 非一般物件、id 不合臂 id 之格式(缺、非字串、小寫、無底線)⇒ 拋 invalid opt / opt.id: must be …; selectable 給了而不是 true / false ⇒ 拋 invalid opt.selectable: must be a boolean(原: 僅 === true 為可選 ⇒ "true"、1 靜默成不可選)', () => {
            for (let v of [null, undefined, 'x', 5, []]) {
                throwsMsg(() => mkArm(v), 'invalid opt: must be an object', `opt ${String(v)}`)
            }
            for (let id of [undefined, null, 5, '', 'a01_x', 'A1_x', 'A01x', 'A01_', {}, ' A01_x', SECRET]) {
                throwsMsg(() => mkArm({ id, title: 't' }), 'invalid opt.id: must be an arm id such as A12_Name', `id ${String(id)}`)
            }
            for (let v of ['true', 'false', 0, 1, '', {}, []]) {
                throwsMsg(() => mkArm({ id: 'A01_nt', title: 't', selectable: v }), 'invalid opt.selectable: must be a boolean', `selectable ${JSON.stringify(v)}`)
            }
        })
        it('mkArm 合法輸入之輸出不變: 可選者之落成名為算子 add:<id> 加載體 <id>、不可選者為 manual; selectable 未給(undefined、null)= 不可選(同改前); 欄位之鍵序同改前', () => {
            let on = mkArm({ id: 'A04_x', n: 4, title: 't', desc: 'd', selectable: true, grid: { k: [1] } })
            assert.deepEqual(on, { id: 'A04_x', n: 4, layer: 'A', title: 't', desc: 'd', status: 'proposed', selectable: true, realize: [{ kind: 'operator', op: 'add:A04_x' }, { kind: 'carrier', name: 'A04_x' }], grid: { k: [1] } })
            assert.deepEqual(Object.keys(on), ['id', 'n', 'layer', 'title', 'desc', 'status', 'selectable', 'realize', 'grid'])
            for (let v of [undefined, null, false]) {
                let off = mkArm({ id: 'I05_y', n: 5, title: 't', selectable: v })
                assert.strictEqual(off.selectable, false)
                assert.deepEqual(off.realize, [{ kind: 'manual', how: '不派給節點(量尺 / 迴圈自身 / 須改評估器)' }])
            }
        })
    })

    describe('g_launch.mjs(日誌名 = rsi/logs 內之檔名; ARSI_ROOT)', () => {
        it('日誌名含路徑分隔、..、:、空白、非英數起首、逾 64 字、裝置名(con、nul、com1…)⇒ 離開碼 2、固定訊息、未建 rsi 夾(原: ../x 使鎖檔、pid 檔與日誌落到日誌夾之外)', () => {
            let want = 'invalid log name: must be 1 to 64 letters, digits, "-" or "_" (starting with a letter or digit; not a reserved device name)'
            let dir = path.join(t.dir, 'launchBad')
            fs.mkdirSync(dir, { recursive: true })
            let n = 0
            for (let name of ['../x', '..\\x', 'a/b', 'a\\b', 'a:b', '.', '..', 'a b', '-x', '_x', 'x'.repeat(65), 'con', 'NUL', 'com1', 'Lpt9', 'prn', 'aux', 'a.b', '日誌', `x${SECRET}/y`]) {
                let r = run('src/cli/launch.mjs', [name, '--', '-e', '0'], dir)
                assert.strictEqual(r.code, 2, `${JSON.stringify(name)}: 離開碼 ${r.code} ${r.err.slice(0, 120)}`)
                assert.strictEqual(r.out, want, JSON.stringify(name))
                assert.ok(!r.out.includes(SECRET), '不回顯')
                n++
            }
            assert(n >= 20)
            assert.deepEqual(fs.readdirSync(dir), [], '未建任何檔')
        })
        it('ARSI_ROOT 指到不存在之資料夾 ⇒ 離開碼 2、invalid ARSI_ROOT: must be an existing directory、不建該夾(原: 逕自 mkdir rsi/logs 於其下)', () => {
            let ghost = path.join(t.dir, 'ghost-root')
            let r = run('src/cli/launch.mjs', ['round', '--', '-e', '0'], t.dir, { ARSI_ROOT: ghost })
            assert.strictEqual(r.code, 2, `${r.out} ${r.err.slice(0, 120)}`)
            assert.strictEqual(r.out, 'invalid ARSI_ROOT: must be an existing directory')
            assert.ok(!fs.existsSync(ghost), '未建該夾')
        })
        it('合法之日誌名(英數起首、含底線與連字號、至多 64 字)通過日誌名之檢查(以「已有執行中」之鎖使其不起子行程: 離開碼 3)', () => {
            let dir = path.join(t.dir, 'launchOk')
            fs.mkdirSync(path.join(dir, 'rsi', 'logs'), { recursive: true })
            for (let name of ['round', 'fill_2', 'A-b_9', 'x'.repeat(64)]) {
                //鎖檔記本測試行程(node)之 pid ⇒ peekRunLock 判為執行中
                fs.writeFileSync(path.join(dir, 'rsi', 'logs', `${name}.lock`), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), beatAt: new Date().toISOString() }), 'utf8')
                let r = run('src/cli/launch.mjs', [name, '--', '-e', '0'], dir)
                assert.strictEqual(r.code, 3, `${name}: 離開碼 ${r.code} ${r.out} ${r.err.slice(0, 120)}`)
                assert(/^未啟動: 已有執行中/.test(r.out), r.out)
            }
        })
    })

    describe('scanTrace(操作紀錄之掃描 = 安全閘)之必給件', () => {
        let dir = () => {
            let d = path.join(t.dir, `scan_${Math.random().toString(36).slice(2, 8)}`)
            fs.mkdirSync(d, { recursive: true })
            return d
        }
        it('opt 非一般物件、workDir 或 privateRoot 非非空字串、logFile 給了而非非空字串、未給 logFile 而 attempt 非正整數(缺、0、小數、字串、布林)⇒ 拋固定訊息(原: 缺 attempt ⇒ 讀不存在之 agent_aundefined.log ⇒ 視為乾淨)', () => {
            let w = dir()
            for (let v of [null, undefined, 'x', 5, []]) {
                throwsMsg(() => scanTrace(v), 'invalid opt: must be an object', `opt ${String(v)}`)
            }
            for (let v of [undefined, '', 5, {}]) {
                throwsMsg(() => scanTrace({ workDir: v, attempt: 1, privateRoot: 'p' }), 'invalid opt.workDir: must be a non-empty string', `workDir ${String(v)}`)
                throwsMsg(() => scanTrace({ workDir: w, attempt: 1, privateRoot: v }), 'invalid opt.privateRoot: must be a non-empty string', `privateRoot ${String(v)}`)
            }
            for (let v of ['', 5, {}, false]) {
                throwsMsg(() => scanTrace({ workDir: w, logFile: v, privateRoot: 'p' }), 'invalid opt.logFile: must be a non-empty string', `logFile ${String(v)}`)
            }
            for (let v of [undefined, null, 0, -1, 1.5, '1', true, NaN, {}]) {
                throwsMsg(() => scanTrace({ workDir: w, attempt: v, privateRoot: 'p' }), 'invalid opt.attempt: must be a positive integer (required unless opt.logFile is given)', `attempt ${String(v)}`)
            }
        })
        it('合法輸入之結果不變: 給了 logFile 者可省 attempt; attempt 為正整數取 agent_a<n>.log; 紀錄中之禁區字樣照列', () => {
            let w = dir()
            let ev = (input) => JSON.stringify({ type: 'tool_use', part: { state: { input } } })
            fs.writeFileSync(path.join(w, 'agent_a2.log'), ev({ command: 'cat g_backtest.mjs' }), 'utf8')
            let a = scanTrace({ workDir: w, attempt: 2, privateRoot: path.join(t.dir, 'priv') })
            assert(a.issues.some((x) => x.includes('回測期工具 g_backtest')), JSON.stringify(a.issues))
            let b = scanTrace({ workDir: w, logFile: path.join(w, 'agent_a2.log'), privateRoot: path.join(t.dir, 'priv') })
            assert.deepEqual(b.issues, a.issues)
            //紀錄檔不存在 ⇒ 無問題(合法之狀態: 該次無操作紀錄; 與缺 attempt 不同)
            assert.deepEqual(scanTrace({ workDir: w, attempt: 9, privateRoot: path.join(t.dir, 'priv') }).issues, [])
        })
    })

    describe('getSettings(必給之節與路徑欄)', () => {
        let probe = path.join(t.dir, 'probe.mjs')
        let msgOf = (mod) => {
            let dir = mkRoot(`gs_${Math.random().toString(36).slice(2, 8)}`, mod)
            fs.writeFileSync(probe, `import { getSettings } from ${JSON.stringify(new URL(`file:///${path.join(FD_ROOT, 'src', 'cfg.mjs').replace(/\\/g, '/')}`).href)}\ntry { getSettings(); console.log('OK') } catch (e) { console.log(String(e.name) + ': ' + String(e.message)) }\n`, 'utf8')
            let r = spawnSync(NODE, [probe], { cwd: dir, env: { ...process.env, ARSI_ROOT: dir }, encoding: 'utf8', windowsHide: true })
            return String(r.stdout || '').trim()
        }
        it('缺節或節非一般物件(eval、rsi、records、dispatch)⇒ invalid settings.<節>: must be an object(原: 原生 TypeError: Cannot read properties of undefined); 設定檔本身非物件 ⇒ invalid settings: must be an object', () => {
            assert.strictEqual(msgOf(() => []), 'Error: invalid settings: must be an object')
            assert.strictEqual(msgOf(() => 'x'), 'Error: invalid settings: must be an object')
            for (let sec of ['eval', 'rsi', 'records', 'dispatch']) {
                assert.strictEqual(msgOf((s) => {
                    delete s[sec]
                    return s
                }), `Error: invalid settings.${sec}: must be an object`, `缺 ${sec}`)
                assert.strictEqual(msgOf((s) => ({ ...s, [sec]: 'x' })), `Error: invalid settings.${sec}: must be an object`, `${sec} 為字串`)
                assert.strictEqual(msgOf((s) => ({ ...s, [sec]: [] })), `Error: invalid settings.${sec}: must be an object`, `${sec} 為陣列`)
            }
        })
        it('路徑欄(eval.ledgerDir、rsi.root、records.*)非字串或空字串 ⇒ invalid settings.<欄>: must be a non-empty string(原: 空字串 ⇒ 專案根本身; 缺 ⇒ 原生 TypeError)', () => {
            assert.strictEqual(msgOf((s) => ({ ...s, eval: { ...s.eval, ledgerDir: '' } })), 'Error: invalid settings.eval.ledgerDir: must be a non-empty string')
            assert.strictEqual(msgOf((s) => ({ ...s, eval: { ...s.eval, ledgerDir: 5 } })), 'Error: invalid settings.eval.ledgerDir: must be a non-empty string')
            assert.strictEqual(msgOf((s) => ({ ...s, rsi: { ...s.rsi, root: '' } })), 'Error: invalid settings.rsi.root: must be a non-empty string')
            assert.strictEqual(msgOf((s) => {
                delete s.rsi.root
                return s
            }), 'Error: invalid settings.rsi.root: must be a non-empty string')
            assert.strictEqual(msgOf((s) => ({ ...s, records: { ...s.records, nodeDir: '' } })), 'Error: invalid settings.records.nodeDir: must be a non-empty string')
            assert.strictEqual(msgOf((s) => ({ ...s, records: { ...s.records, workDir: null } })), 'Error: invalid settings.records.workDir: must be a non-empty string')
        })
        it('派工之設定: agents 給了而不是一般物件、角色之 kind 非 opencode 或 claude、fallback 不合、dispatch.skillsRoot 給了而非字串 ⇒ 拋固定訊息(原: 其後於派工器內為原生 TypeError 或靜默走 opencode 分支); agents 未給、角色為 false、fallback 為 false 或 null ⇒ 合格', () => {
            assert.strictEqual(msgOf((s) => ({ ...s, agents: 'x' })), 'Error: invalid settings.agents: must be an object')
            assert.strictEqual(msgOf((s) => ({ ...s, agents: { node: { ...s.agents.node, kind: 'codex' } } })), 'Error: invalid settings.agents.node.kind: must be one of opencode, claude')
            assert.strictEqual(msgOf((s) => ({ ...s, agents: { node: 'x' } })), 'Error: invalid settings.agents.node: must be an object')
            assert.strictEqual(msgOf((s) => ({ ...s, agents: { node: { ...s.agents.node, fallback: 'x' } } })), 'Error: invalid settings.agents.node.fallback: must be an array of objects')
            assert.strictEqual(msgOf((s) => ({ ...s, agents: { node: { ...s.agents.node, fallback: [{ kind: 'x' }] } } })), 'Error: invalid settings.agents.node.fallback[].kind: must be one of opencode, claude')
            assert.strictEqual(msgOf((s) => ({ ...s, dispatch: { ...s.dispatch, skillsRoot: 5 } })), 'Error: invalid settings.dispatch.skillsRoot: must be a non-empty string')
            assert.strictEqual(msgOf((s) => ({ ...s, dispatch: { ...s.dispatch, skillsRoot: { x: 1 } } })), 'Error: invalid settings.dispatch.skillsRoot: must be a non-empty string')
            assert.strictEqual(msgOf((s) => {
                delete s.agents
                return s
            }), 'OK', 'agents 未給')
            assert.strictEqual(msgOf((s) => ({ ...s, agents: { ...s.agents, dream: false } })), 'OK', '角色為 false = 未設定')
            assert.strictEqual(msgOf((s) => ({ ...s, agents: { node: { ...s.agents.node, fallback: false } } })), 'OK', 'fallback: false = 無備援')
            assert.strictEqual(msgOf((s) => ({ ...s, agents: { node: { ...s.agents.node, fallback: null } } })), 'OK', 'fallback: null = 未給')
            assert.strictEqual(msgOf((s) => ({ ...s, dispatch: { ...s.dispatch, skillsRoot: '' } })), 'OK', 'skillsRoot 空字串 = 未給 ⇒ 取使用者家目錄下之預設')
        })
        it('合法之設定照常(路徑轉為專案根下之絕對路徑)', () => {
            assert.strictEqual(msgOf((s) => s), 'OK')
        })
    })
})
