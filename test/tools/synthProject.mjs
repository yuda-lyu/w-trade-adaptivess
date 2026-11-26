import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { getSettings } from '../../src/cfg.mjs'
import { makeProject } from '../../src/domain/domain.mjs'
import { writeSynthLedger, FD_ROOT } from './synthLedger.mjs'


//測試用: 合成專案(合成帳本 + 專案設定 + 行程內之專案物件, 同一組檔)與命令列入口之執行(同步與「持有」兩種); 暫存夾由呼叫端(makeTmp)給定、自刪
//  合成專案之內容同 unit-frontierOps 之 mkProject(該檔保留自己之定義; 新測試共用本檔)
export let HOLD_AT_EXIT = path.join(FD_ROOT, 'test', 'tools', 'holdAtExit.mjs')

//makeSynthProject, 於 dir 下建 root(專案根): 回 { root, P, st }; init 為 false 者不呼叫 rsi.init()(供 --mode init 之全新狀態根)
export let makeSynthProject = (dir, name, { init = true } = {}) => {
    let root = path.join(dir, name)
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
    if (init) {
        P.rsi.init()
    }
    return { root, P, st: s }
}

//cleanEnv, 子行程之環境: 專案根指向 root、清除會改變入口行為之變數
let cleanEnv = (root, extra = {}) => {
    let env = { ...process.env, ARSI_ROOT: root, ...extra }
    for (let k of ['ARSI_HARNESS', 'ARSI_LEDGER_DIR', 'ARSI_EVAL_FROM', 'ARSI_AGENT_ROLE']) {
        delete env[k]
    }
    return env
}

//runEntry, 同步執行命令列入口(rel = 相對於套件根之路徑, 如 ['src', 'cli', 'rsi.mjs']): 回 { status, out: 標準輸出之非空列, err: 標準錯誤之文字 }
export let runEntry = (root, rel, args) => {
    let r = spawnSync(process.execPath, [path.join(FD_ROOT, ...rel), ...args], { cwd: root, env: cleanEnv(root), windowsHide: true, encoding: 'utf8', timeout: 280000 })
    return { status: r.status, out: `${r.stdout}`.split(/\r?\n/).filter(Boolean), err: `${r.stderr}` }
}

//sleepEvent, 等「事件」之輪詢(以 setTimeout 讓出事件迴圈; 間隔只決定檢查之頻率、不是斷言之依據)
let nap = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

//holdEntry, 非同步起一個「持有」之命令列入口: 預載 holdAtExit.mjs ⇒ 該入口於結束(含 process.exit)時、於釋放鎖之前, 先寫信號檔(含當下鎖檔之內容與其於首次寫狀態根之檔時之鎖檔內容)後暫停, 至 go 檔出現才續行
//  回 { child, waitSignal(): Promise<信號 | null(入口已結束而無信號)>, release(): 建 go 檔, done: Promise<{ status, out, err }> }
export let holdEntry = (root, rel, args, tag) => {
    let dir = path.join(root, '..', `_hold_${tag}`)
    fs.mkdirSync(dir, { recursive: true })
    let sig = path.join(dir, 'signal.json')
    let go = path.join(dir, 'go')
    let lockFp = path.join(root, 'rsi', 'logs', 'round.lock')
    let child = spawn(process.execPath, ['--import', pathToFileURL(HOLD_AT_EXIT).href, path.join(FD_ROOT, ...rel), ...args], {
        cwd: root,
        env: cleanEnv(root, { HOLD_SIGNAL: sig, HOLD_GO: go, HOLD_LOCK: lockFp, HOLD_ROOT: root }),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => {
        out += c
    })
    child.stderr.on('data', (c) => {
        err += c
    })
    let exited = false
    let done = new Promise((resolve) => {
        child.on('exit', (status) => {
            exited = true
            resolve({ status, out: out.split(/\r?\n/).filter(Boolean), err })
        })
    })
    return {
        child,
        done,
        waitSignal: async () => {
            for (let i = 0; i < 6000; i++) {
                if (fs.existsSync(sig)) {
                    return JSON.parse(fs.readFileSync(sig, 'utf8'))
                }
                if (exited) {
                    return null
                }
                await nap(20)
            }
            throw new Error('hold: 信號檔未出現(逾 120 秒)')
        },
        release: () => {
            fs.writeFileSync(go, 'go', 'utf8')
        },
    }
}
