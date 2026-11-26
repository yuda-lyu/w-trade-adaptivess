/* eslint-disable no-template-curly-in-string -- 本檔之盤點案以正規式比對原始碼之片段(含 ${…}) */
import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { decideArgsOf } from '../src/domain/armCatalog.mjs'
import { FD_ROOT, makeTmp } from './tools/synthLedger.mjs'


//範圍外之既有輸入值回顯之改寫(排程第 611 項 ②; 跨套件規格〈輸入參數之檢測機制〉K9「不回顯輸入值」、V20; R-EV-56): 下列 5 處之訊息一律不帶輸入值(命令列之前綴、臂代號、設定檔之時間), 可帶計數與序號
//  規格之句 ⇒ 案: 「不帶輸入值」= 以祕密字樣為輸入之值, 逐案斷言輸出恰為固定訊息、不含該字樣; 「可帶 N 個之計數」= 訊息之計數(符合 N 個)與樹上之實況相同
//  5 處: ① g_rsi.mjs --only 未命中之前綴(unit-fillCli 之既有案已同步改寫: 不含輸入之前綴) ② armDecide --arm-id 之「收到 <值>」③ armInactive / exposure 之「節點 <前綴>: 符合 N 個」④ replayCheck 之「<前綴>: 找不到此節點之工作夾」
//    ⑤ g_build.mjs 之「帳本終點 … 已進入保留期」(unit-inputGates 之既有案已同步改寫: 不含時間)
let NODE = process.execPath
let SECRET = 'secret-token-xyz'

describe('範圍外之既有輸入值回顯之改寫(R-EV-56 ②; K9)', function () {
    this.timeout(300000)
    let t = makeTmp('inputEcho')
    after(() => t.cleanup())
    //專案根: 參考設定(關閉資源閘)+ 帳本之 meta(只有鍵; 組裝專案用)+ 狀態根之 work 夾(replayCheck 用)
    let mkRoot = (name) => {
        let dir = path.join(t.dir, name)
        let s = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        s.resources = {}
        fs.mkdirSync(path.join(dir, 'data', 'ledger', 'eval'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'data', 'ledger', 'eval', 'meta.json'), JSON.stringify({ key: 'synthEcho' }), 'utf8')
        fs.mkdirSync(path.join(dir, 'rsi', 'work'), { recursive: true })
        fs.cpSync(path.join(FD_ROOT, 'arms'), path.join(dir, 'arms'), { recursive: true }) //臂目錄之基底(組裝專案用)
        //派工套件之最小替身(本案之工具不派工; makeProject 組裝派工器時須載入得到 —— 不依賴本機技能根之 w-dispatch-ai, 於發布包解開之沙箱亦可跑; 同 unit-fillCli)
        let sk = path.join(dir, 'skills', 'node_modules', 'w-dispatch-ai')
        fs.mkdirSync(sk, { recursive: true })
        fs.writeFileSync(path.join(sk, 'package.json'), JSON.stringify({ name: 'w-dispatch-ai', main: 'index.cjs' }), 'utf8')
        fs.writeFileSync(path.join(sk, 'index.cjs'), 'module.exports = { providers: [], readEnvFile: () => ({}), dispatchOpencode: async () => ({ ok: false, error: \'stub\' }), dispatchClaude: async () => ({ ok: false, error: \'stub\' }) }\n', 'utf8')
        fs.writeFileSync(path.join(dir, '.env'), '', 'utf8')
        s.dispatch = { skillsRoot: path.join(dir, 'skills'), envFile: path.join(dir, '.env') }
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(s, null, 1), 'utf8')
        return dir
    }
    let run = (rel, args, dir) => {
        let e = { ...process.env, ARSI_ROOT: dir }
        delete e.ARSI_AGENT_ROLE
        let r = spawnSync(NODE, [path.join(FD_ROOT, rel), ...args], { cwd: dir, env: e, encoding: 'utf8', windowsHide: true, timeout: 120000 })
        return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }
    }

    it('② armDecide --arm-id: 不合之臂代號 ⇒ 訊息固定、不帶輸入之臂代號(原: 「收到 <值>」); 現有層(目錄之內容)照列; 合格之臂代號不受影響', () => {
        let cat = { layers: { A: { name: 'a' }, B: { name: 'b' } }, arms: [] }
        let p = { kind: 'new', title: 't', layer: 'A' }
        for (let armId of [`${SECRET}`, `Z99_${SECRET}`, 'A1', 'A01_bad name', 'A01-x', 'a01_x', 'Z01_x']) {
            let r = decideArgsOf(p, { accept: true, armId, catalog: cat })
            assert.deepEqual(r, { error: '--arm-id 須為 <既有之層代號><流水號>_<英數名>(現有層: A B)' }, armId)
            assert(!JSON.stringify(r).includes(armId), `不回顯 ${armId}`)
        }
        //對照: 合格(既有之層 A 之流水號 + 英數名)⇒ 通過(取其值, 無 error)
        let ok = decideArgsOf(p, { accept: true, armId: 'A01_okName', catalog: cat })
        assert.strictEqual(ok.error, undefined, JSON.stringify(ok))
    })

    it('③ armInactive、exposure: 前綴不符合恰 1 個 ⇒ 離開碼 2、`節點前綴符合 N 個(須恰為 1 個)`(N 為實況: 空樹 0 個)、不含輸入之前綴(原: `節點 <前綴>: 符合 N 個`)', () => {
        let dir = mkRoot('hit')
        for (let [rel, args] of [['src/tools/armInactive.mjs', ['--node', `${SECRET}abc`, '--arms', 'none', '--why', 'x']], ['src/tools/exposure.mjs', ['--node', `${SECRET}abc`, '--why', 'x']]]) {
            let r = run(rel, args, dir)
            assert.strictEqual(r.code, 2, `${rel}: ${r.out}${r.err}`.slice(0, 400))
            assert.strictEqual(r.err, '節點前綴符合 0 個(須恰為 1 個)\n', rel)
            assert(!`${r.out}${r.err}`.includes(SECRET), `${rel}: 不回顯輸入之前綴`)
        }
    })

    it('④ replayCheck: 找不到節點之工作夾 ⇒ `第 N 個前綴: 找不到此節點之工作夾`(N 為其於命令列之序號, 自 1 起)、不含輸入之前綴、離開碼 1(原: `<前綴>: 找不到此節點之工作夾`); 各前綴逐一報告', () => {
        let dir = mkRoot('replay')
        let r = run('src/tools/replayCheck.mjs', [`${SECRET}1`, `${SECRET}2`, `${SECRET}3`], dir)
        assert.strictEqual(r.code, 1, `${r.out}${r.err}`.slice(0, 400))
        assert.strictEqual(r.out, '第 1 個前綴: 找不到此節點之工作夾\n第 2 個前綴: 找不到此節點之工作夾\n第 3 個前綴: 找不到此節點之工作夾\n')
        assert(!`${r.out}${r.err}`.includes(SECRET), '不回顯輸入之前綴')
        //單一前綴: 序號 1
        let r1 = run('src/tools/replayCheck.mjs', [SECRET], dir)
        assert.strictEqual(r1.out, '第 1 個前綴: 找不到此節點之工作夾\n')
    })

    it('原始碼之盤點: 上列各訊息之模板字串不含輸入之變數(armCatalog 之收到、armInactive / exposure 之 ${key}、replayCheck 之 ${pre}、build 之 ${endTime} 與 holdoutFrom、rsi 之 list.join)', () => {
        let src = (rel) => fs.readFileSync(path.join(FD_ROOT, rel), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
        assert(!/收到 \$\{/.test(src('src/domain/armCatalog.mjs')), 'armCatalog: 無「收到 ${…}」')
        for (let rel of ['src/tools/armInactive.mjs', 'src/tools/exposure.mjs']) {
            assert(!/節點 \$\{key\}/.test(src(rel)), `${rel}: 無「節點 \${key}」`)
        }
        assert(!/\$\{pre\}:/.test(src('src/tools/replayCheck.mjs')), 'replayCheck: 無「${pre}:」')
        assert(!/帳本終點 \$\{/.test(src('src/cli/build.mjs')) && !/已進入保留期\(\$\{/.test(src('src/cli/build.mjs')), 'build: 保留期之訊息不帶時間')
        assert(!/未命中任何已執行之節點\(\$\{/.test(src('src/cli/rsi.mjs')), 'rsi: --only 之訊息不帶前綴')
        //同檔鄰近之訊息(複審所得): armDecide 之「提案帳無此筆」不帶提案 id、armInactive 之臂不符不帶臂名
        assert(!/提案帳無此筆: \$\{/.test(src('src/tools/armDecide.mjs')) && /console\.error\('提案帳無此筆'\)/.test(src('src/tools/armDecide.mjs')), 'armDecide: 不帶提案 id')
        assert(!/\$\{bad\.join\(/.test(src('src/tools/armInactive.mjs')) && /所給之臂有 \$\{bad\.length\} 個不是節點/.test(src('src/tools/armInactive.mjs')), 'armInactive: 不帶臂名')
        //鑑別前提: 同一組樣式抓得到舊寫法
        assert(/收到 \$\{/.test('(收到 ${armId};現有層: ${x})') && /節點 \$\{key\}/.test('`節點 ${key}: 符合') && /\$\{pre\}:/.test('`${pre}: 找不到') && /未命中任何已執行之節點\(\$\{/.test('`--only 未命中任何已執行之節點(${list.join'))
    })
})
