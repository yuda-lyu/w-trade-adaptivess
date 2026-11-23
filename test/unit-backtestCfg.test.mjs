import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { backtestCfg } from '../src/domain/backtestCfg.mjs'
import { configMsgOf } from '../src/eval/barGrid.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//settings.backtest 之數值鍵(minLadder、replicas、nullDraws、timeoutSec)依 K3(決定資料口徑之 opt: 給了而無效即拒絕)、K4、K7 取值(排程第 547 項①; 與 settings.eval 之數值鍵同一口徑, R-EV-44 ④之二)
//  規格之句: 未給(undefined 或 null)= 預設; 數字原樣; 數字字串轉為數值後才使用(其後不再用原字串); 給了而無效(布林、陣列、物件、NaN、±Infinity、空字串、非數字字串、值域外)⇒ 拋 invalid backtest.<鍵>: must be …(不帶輸入值);
//  命令列之入口(g_backtest.mjs、g_toolbox.mjs、g_rsi.mjs 等組裝專案者)印 ERROR invalid backtest.<鍵>…、離開碼 2、不寫任何檔
//  原: Number.isInteger ? 值 : 預設 —— replicas: 2.5 與 '5' 皆靜默為 3 份複製版、nullDraws: '32' 與 1.5 皆靜默為 64 抽、minLadder: -1 照收、timeoutSec: 0 與 'abc' 靜默為 1200 秒(`||`)
let NODE = process.execPath
let SECRET = 'secret-token-xyz'
let KEYS = {
    minLadder: { def: 0, msg: 'a non-negative integer', ok: [[0, 0], [2, 2], ['3', 3], [' 4 ', 4]], bad: [-1, 1.5, 'abc', '', true, false, [], {}, NaN, Infinity, 2 ** 53, '0x10'] },
    replicas: { def: 3, msg: 'a positive integer', ok: [[1, 1], [5, 5], ['5', 5]], bad: [0, -1, 2.5, 'abc', '', true, [], {}, NaN, Infinity, '0'] },
    nullDraws: { def: 64, msg: 'a non-negative integer', ok: [[0, 0], [16, 16], ['32', 32]], bad: [-1, 1.5, 'abc', '', true, [], {}, NaN, Infinity, '1.5'] },
    timeoutSec: { def: 1200, msg: 'a positive number of seconds that is at most 2147483', ok: [[0.5, 0.5], [60, 60], ['90', 90]], bad: [0, -1, 'abc', '', true, [], {}, NaN, Infinity, 3e6, '0'] },
}

describe('settings.backtest 之數值鍵(排程第 547 項①)', function () {
    this.timeout(300000)
    let t = makeTmp('backtestCfg')
    after(() => t.cleanup())

    describe('backtestCfg(純函數)', () => {
        it('未給(含 backtest 本身未給、undefined、null)= 預設: minLadder 0、replicas 3、nullDraws 64、timeoutSec 1200(逐位同修前之預設)', () => {
            for (let st of [{}, { backtest: {} }, { backtest: null }, { backtest: { minLadder: undefined, replicas: null, nullDraws: undefined, timeoutSec: null } }]) {
                let c = backtestCfg(st)
                for (let [k, spec] of Object.entries(KEYS)) {
                    assert.strictEqual(c[k], spec.def, `${JSON.stringify(st)}: ${k}`)
                }
            }
        })

        for (let [k, spec] of Object.entries(KEYS)) {
            it(`${k}: 數字原樣、數字字串轉為數值(其後只用轉換值); 給了而無效 ⇒ 拋 invalid backtest.${k}: must be ${spec.msg}(不帶輸入值)`, () => {
                for (let [v, want] of spec.ok) {
                    let c = backtestCfg({ backtest: { [k]: v } })
                    assert.strictEqual(c[k], want, `${k} ${JSON.stringify(v)}`)
                    assert.strictEqual(typeof c[k], 'number', '轉換後為數值')
                }
                for (let v of spec.bad) {
                    assert.throws(() => backtestCfg({ backtest: { [k]: v } }), (e) => e.message === `invalid backtest.${k}: must be ${spec.msg}`, `${k} ${String(v)}`)
                }
                //不回顯: 值為獨特字串者之訊息不含它
                assert.throws(() => backtestCfg({ backtest: { [k]: SECRET } }), (e) => !e.message.includes(SECRET) && e.message === `invalid backtest.${k}: must be ${spec.msg}`)
            })
        }

        it('各鍵只讀一次(檢查之值即使用之值): 以存取子計讀取次數 ⇒ 各鍵恰 1 次; 讀取拋錯者視為無效(V11)', () => {
            let n = { minLadder: 0, replicas: 0, nullDraws: 0, timeoutSec: 0 }
            let b = {}
            for (let k of Object.keys(n)) {
                Object.defineProperty(b, k, {
                    enumerable: true,
                    get: () => {
                        n[k]++
                        return KEYS[k].ok[0][0]
                    },
                })
            }
            backtestCfg({ backtest: b })
            assert.deepEqual(n, { minLadder: 1, replicas: 1, nullDraws: 1, timeoutSec: 1 })
            let thrower = {}
            Object.defineProperty(thrower, 'replicas', {
                enumerable: true,
                get: () => {
                    throw new Error('boom')
                },
            })
            assert.throws(() => backtestCfg({ backtest: thrower }), (e) => e.message === 'boom', '存取子之錯誤照拋(不被吞成預設)')
        })

        it('其餘之欄不變: 路徑(privateRoot 之預設、ledgerDir、resultDir)、enabled、rule、grade(合併)', () => {
            let c = backtestCfg({ backtest: { enabled: false, privateRoot: path.join(t.dir, 'pr'), rule: { meanMin: 1 }, grade: { splits: 3, enabled: true } } })
            assert.strictEqual(c.enabled, false)
            assert.strictEqual(c.privateRoot, path.join(t.dir, 'pr'))
            assert.strictEqual(c.ledgerDir, path.join(t.dir, 'pr', 'ledger', 'full'))
            assert.strictEqual(c.resultDir, path.join(t.dir, 'pr', 'backtest'))
            assert.deepEqual(c.rule, { meanMin: 1, worstPhaseMin: 0 })
            assert.deepEqual(c.grade, { enabled: true, pAbove: 0.05, pBelow: 0.95, pStrong: 0.01, splits: 3, matchSides: true })
        })

        it('configMsgOf 認 invalid backtest.…(命令列之入口據以印 ERROR、離開碼 2); 非設定不合之錯誤回 null(照舊拋出)', () => {
            assert.strictEqual(configMsgOf(new Error('invalid backtest.replicas: must be a positive integer')), 'invalid backtest.replicas: must be a positive integer')
            assert.strictEqual(configMsgOf(new Error('boom')), null)
        })
    })

    describe('命令列之入口(子行程): 設定無效 ⇒ ERROR invalid backtest.<鍵>、離開碼 2、不寫任何檔', () => {
        let mkRoot = (name, backtest) => {
            let root = path.join(t.dir, name)
            fs.mkdirSync(root, { recursive: true })
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
                eval: { ledgerDir: './ledger/eval' },
                backtest,
                rsi: { root: './rsi' },
                records: {},
                dispatch: {},
            }), 'utf8')
            return root
        }
        let run = (root, script, args, env = {}) => {
            let e = { ...process.env, ARSI_ROOT: root, ...env }
            delete e.ARSI_AGENT_ROLE
            let r = spawnSync(NODE, [path.join(FD_ROOT, 'src', script.includes('/') ? '' : 'cli', script), ...args], { cwd: root, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            return { status: r.status, out: `${r.stdout}`.split(/\r?\n/).filter(Boolean), err: r.stderr }
        }
        it('g_backtest.mjs(於讀帳本與載入模組之前; 不寫結果檔): 四個鍵各一', () => {
            for (let [k, spec] of Object.entries(KEYS)) {
                let root = mkRoot(`bt_${k}`, { [k]: 'abc', privateRoot: path.join(t.dir, `pr_${k}`) })
                let r = run(root, 'backtest.mjs', ['--pick', 'p.mjs', '--name', 'n'], { ARSI_HARNESS: '1' })
                assert.strictEqual(r.status, 2, `${k}: ${r.out.join('|').slice(0, 200)} ${r.err.slice(0, 200)}`)
                assert.deepEqual(r.out, [`ERROR invalid backtest.${k}: must be ${spec.msg}`], k)
                assert(!fs.existsSync(path.join(t.dir, `pr_${k}`)), `${k}: 不建私有根`)
            }
        })

        it('g_backtest.mjs / g_toolbox.mjs: settings.backtest.rule.* 與 grade.* 給了而無效(排程第 595 項之接續 ⑦)⇒ ERROR invalid backtest.<路徑>、離開碼 2、不建私有根; 數字字串合格者不被拒', () => {
            for (let [name, bt, want] of [
                ['rl1', { rule: { meanMin: 'abc' } }, 'ERROR invalid backtest.rule.meanMin: must be a finite number'],
                ['rl2', { rule: { worstPhaseMin: true } }, 'ERROR invalid backtest.rule.worstPhaseMin: must be a finite number'],
                ['gr1', { grade: { pAbove: 1.5 } }, 'ERROR invalid backtest.grade.pAbove: must be a number from 0 to 1'],
                ['gr2', { grade: { splits: 2.5 } }, 'ERROR invalid backtest.grade.splits: must be a positive integer'],
            ]) {
                let root = mkRoot(`bt_${name}`, { ...bt, privateRoot: path.join(t.dir, `pr_${name}`) })
                let r = run(root, 'backtest.mjs', ['--pick', 'p.mjs', '--name', 'n'], { ARSI_HARNESS: '1' })
                assert.strictEqual(r.status, 2, `${name}: ${r.out.join('|').slice(0, 200)} ${r.err.slice(0, 200)}`)
                assert.deepEqual(r.out, [want], name)
                assert(!fs.existsSync(path.join(t.dir, `pr_${name}`)), `${name}: 不建私有根`)
                let r2 = run(root, 'toolbox.mjs', [])
                assert.strictEqual(r2.status, 2, `${name} toolbox: ${r2.out.join('|').slice(0, 200)}`)
                assert.deepEqual(r2.out, [want], `${name} toolbox`)
            }
            let ok = mkRoot('bt_okstr', { rule: { meanMin: '0.1', worstPhaseMin: ' -1 ' }, grade: { pAbove: '0.04', pBelow: '0.96', pStrong: '0.02', splits: '3' } })
            let r3 = run(ok, 'toolbox.mjs', [])
            assert(!r3.out.some((l) => l.includes('invalid backtest')), r3.out.join('|').slice(0, 300))
        })

        it('g_toolbox.mjs(唯讀之自檢): 同; 設定合格者不被拒', () => {
            let bad = mkRoot('tb_bad', { replicas: 2.5 })
            let r = run(bad, 'toolbox.mjs', [])
            assert.strictEqual(r.status, 2, `${r.out.join('|').slice(0, 200)} ${r.err.slice(0, 200)}`)
            assert.deepEqual(r.out, ['ERROR invalid backtest.replicas: must be a positive integer'])
            let ok = mkRoot('tb_ok', { replicas: '2' })
            let r2 = run(ok, 'toolbox.mjs', [])
            assert(!r2.out.some((l) => l.includes('invalid backtest')), r2.out.join('|').slice(0, 300))
        })

        it('tools/scanCheck.mjs(唯讀之重掃工具; 原: 設定無效時未處理之堆疊): ERROR invalid backtest.<鍵>、離開碼 2', () => {
            let bad = mkRoot('sc_bad', { nullDraws: -1 })
            let r = run(bad, 'tools/scanCheck.mjs', [])
            assert.strictEqual(r.status, 2, `${r.out.join('|').slice(0, 200)} ${r.err.slice(0, 200)}`)
            assert.deepEqual(r.out, ['ERROR invalid backtest.nullDraws: must be a non-negative integer'])
        })
    })
})
