import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { FD_ROOT, makeTmp } from './tools/synthLedger.mjs'


//命令列與工具之入口讀設定之唯一入口 settingsOrExit(排程第 611 項 ①; R-EV-56): 設定不合 ⇒ `ERROR <固定訊息>` + 離開碼 2(不印堆疊、不回顯檔案之內容), 先於任何寫入
//  規格之句 ⇒ 案: 「所有進入檔與工具之 getSettings() 呼叫改經它」= 原始碼之盤點(無直接呼叫; 每個入口恰一次; 檔案集合 = 已分類之全集);
//    「ERROR + 離開碼 2、訊息固定(V19)、不回顯輸入值(K9)」= 23 個入口 × 各種不合之設定(不存在、不是 JSON〔內含祕密字樣〕、節缺、路徑欄空字串、非物件)之實跑, 恰一行、stderr 空、未建任何檔;
//    「先於任何寫入」= 實跑後空專案根之檔案集合不變
//  修前(1.0.47): 各入口以 getSettings() 之未捕捉例外結束(堆疊、離開碼 1; 僅 libCheck 例外)
let NODE = process.execPath
let SECRET = 'secret-token-xyz'
//入口(src/cli 與 src/tools)之全集: [檔, 到達讀設定所需之命令列, 環境]; 其餘未讀設定之入口列於 NO_SETTINGS(新增之入口須歸入其一, 否則下方之盤點案失敗)
let ENTRIES = [
    ['src/cli/eval.mjs', ['--pick', 'x.mjs'], {}],
    ['src/cli/backtest.mjs', ['--pick', 'p.mjs', '--name', 'n'], { ARSI_HARNESS: '1' }],
    ['src/cli/build.mjs', [], {}],
    ['src/cli/rsi.mjs', ['--mode', 'status'], {}],
    ['src/cli/toolbox.mjs', [], {}],
    ...['archiveDocs', 'armDecide', 'armInactive', 'briefPreview', 'dreamProfile', 'exposure', 'fakeRound', 'formSet', 'improveTrend', 'libCheck', 'nodeAudit', 'pickStore', 'quota', 'rankCompare', 'roundDigest', 'scanCheck', 'searchMap', 'smokeDispatch', 'waitEvent'].map((n) => [`src/tools/${n}.mjs`, [], {}]),
]
let NO_SETTINGS = ['src/cli/launch.mjs', 'src/tools/buildCatalog.mjs', 'src/tools/initProject.mjs', 'src/tools/replayCheck.mjs']

//codeLinesOf, 去掉註解列(整行為 // 、* 、/* 起首者)之程式行
let codeLinesOf = (text) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
//直接呼叫 getSettings 之行(單一定義: 盤點案與其鑑別前提共用)
let directCallsOf = (text) => codeLinesOf(text).filter((l) => /\bgetSettings\b/.test(l.replace(/\s\/\/.*$/, '')))

describe('進入檔與工具讀設定之唯一入口 settingsOrExit(R-EV-56)', function () {
    this.timeout(600000)
    let t = makeTmp('settingsOrExit')
    after(() => t.cleanup())
    let mkRoot = (name, put) => {
        let dir = path.join(t.dir, name)
        fs.mkdirSync(dir, { recursive: true })
        if (put) {
            put(path.join(dir, 'settings.json'))
        }
        return dir
    }
    let base = () => JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
    let run = (rel, args, dir, env = {}) => {
        let e = { ...process.env, ARSI_ROOT: dir, ...env }
        delete e.ARSI_AGENT_ROLE
        let r = spawnSync(NODE, [path.join(FD_ROOT, rel), ...args], { cwd: dir, env: e, encoding: 'utf8', windowsHide: true, timeout: 120000 })
        return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }
    }
    let unreadable = (dir) => `ERROR 無法讀取專案設定(settings.json 不存在、不可讀或內容不合; ${path.resolve(dir, 'settings.json')});請於專案根執行, 或設定 ARSI_ROOT\n`

    describe('原始碼之盤點', () => {
        it('src/cli 與 src/tools 之各檔: 非註解行無 getSettings(直接呼叫已全改經 settingsOrExit); 讀設定之入口各有恰一次 settingsOrExit() 與其匯入; 檔案集合 = 已分類之全集(ENTRIES + NO_SETTINGS)', () => {
            let all = []
            for (let d of ['src/cli', 'src/tools']) {
                for (let f of fs.readdirSync(path.join(FD_ROOT, d)).filter((x) => x.endsWith('.mjs'))) {
                    all.push(`${d}/${f}`)
                }
            }
            assert.deepEqual(all.slice().sort(), [...ENTRIES.map((e) => e[0]), ...NO_SETTINGS].sort(), '新增或移除之入口須歸入 ENTRIES 或 NO_SETTINGS')
            let bad = []
            for (let rel of all) {
                let text = fs.readFileSync(path.join(FD_ROOT, rel), 'utf8')
                for (let l of directCallsOf(text)) {
                    bad.push(`${rel}: ${l.trim().slice(0, 100)}`)
                }
            }
            assert.deepEqual(bad, [], '不得直接呼叫 getSettings(一律 settingsOrExit)')
            for (let [rel] of ENTRIES) {
                let text = fs.readFileSync(path.join(FD_ROOT, rel), 'utf8')
                let code = codeLinesOf(text).join('\n')
                assert.equal((code.match(/\bsettingsOrExit\(\)/g) || []).length, 1, `${rel}: 恰一次 settingsOrExit()`)
                assert(/^import \{[^}]*\bsettingsOrExit\b[^}]*\} from '\.\.\/cfg\.mjs'/m.test(code), `${rel}: 自 ../cfg.mjs 匯入 settingsOrExit`)
            }
            for (let rel of NO_SETTINGS) {
                assert(!/settingsOrExit/.test(fs.readFileSync(path.join(FD_ROOT, rel), 'utf8').replace(/^\s*\/\/.*$/gm, '')), `${rel}: 不讀設定者不呼叫`)
            }
        })

        it('鑑別前提: 盤點函數抓得到舊寫法(`let st = getSettings()`、匯入、行內註解前之呼叫); 不誤抓註解列; cfg.mjs 本身定義 getSettings 與 settingsOrExit', () => {
            assert.equal(directCallsOf('import { getSettings, cliGuard } from \'../cfg.mjs\'\nlet st = getSettings()\n').length, 2)
            assert.equal(directCallsOf('//getSettings 之說明\n * getSettings()\nlet x = 1 // getSettings\n').length, 0)
            assert.equal(directCallsOf('    r = await buildPickStore(getSettings())\n').length, 1)
            let cfg = fs.readFileSync(path.join(FD_ROOT, 'src', 'cfg.mjs'), 'utf8')
            assert(/^let getSettings = /m.test(cfg) && /^let settingsOrExit = /m.test(cfg))
            assert(/export \{[^}]*\bsettingsOrExit\b/.test(cfg))
            //規則 R-REC-53 之 tools/formSet.mjs 加入後為 24 個(tools 19)
            assert.equal(ENTRIES.length, 24, '讀設定之入口 24 個(cli 5、tools 19)')
        })
    })

    describe('實跑: 23 個入口 × 設定不合之各形(ERROR + 離開碼 2、恰一行固定訊息、stderr 空、未建任何檔)', () => {
        it('設定檔不存在、不是合法之 JSON(內含祕密字樣)⇒ `ERROR 無法讀取專案設定(…)`(只帶 settings.json 之路徑; 不回顯檔案之內容)', () => {
            let bad = []
            for (let [name, put] of [['none', null], ['json', (fp) => fs.writeFileSync(fp, `{ "${SECRET}": `, 'utf8')], ['dir', (fp) => fs.mkdirSync(fp)]]) {
                let dir = mkRoot(`rd_${name}`, put)
                let before = fs.readdirSync(dir).sort()
                for (let [rel, args, env] of ENTRIES) {
                    let r = run(rel, args, dir, env)
                    if (r.code !== 2 || r.out !== unreadable(dir) || r.err !== '' || r.out.includes(SECRET)) {
                        bad.push(`${name} ${rel}: code ${r.code}; out ${JSON.stringify(r.out.slice(0, 200))}; err ${JSON.stringify(r.err.slice(0, 160))}`)
                    }
                }
                assert.deepEqual(fs.readdirSync(dir).sort(), before, `${name}: 未建任何檔`)
            }
            assert.deepEqual(bad, [])
        })

        it('設定之節或路徑欄不合(非物件、缺節、路徑欄為空字串)⇒ `ERROR invalid settings.<節或欄>: must be …`(V19; 固定訊息、不帶輸入值)', () => {
            let cases = [
                ['notobj', () => '[]', 'ERROR invalid settings: must be an object\n'],
                ['noeval', () => JSON.stringify((({ eval: _e, ...s }) => s)(base())), 'ERROR invalid settings.eval: must be an object\n'],
                ['norecords', () => JSON.stringify({ ...base(), records: 5 }), 'ERROR invalid settings.records: must be an object\n'],
                ['emptyledger', () => JSON.stringify({ ...base(), eval: { ...base().eval, ledgerDir: '' } }), 'ERROR invalid settings.eval.ledgerDir: must be a non-empty string\n'],
                ['recordsval', () => JSON.stringify({ ...base(), records: { ...base().records, nodeDir: 7 } }), 'ERROR invalid settings.records.nodeDir: must be a non-empty string\n'],
                //鍵名不合 \w{1,40} 者寫 <key>(不回顯鍵名)
                ['recordskey', () => JSON.stringify({ ...base(), records: { ...base().records, [`${SECRET}-bad key`]: '' } }), 'ERROR invalid settings.records.<key>: must be a non-empty string\n'],
            ]
            let bad = []
            for (let [name, mk, want] of cases) {
                let dir = mkRoot(`inv_${name}`, (fp) => fs.writeFileSync(fp, mk(), 'utf8'))
                let before = fs.readdirSync(dir).sort()
                for (let [rel, args, env] of ENTRIES) {
                    let r = run(rel, args, dir, env)
                    if (r.code !== 2 || r.out !== want || r.err !== '' || r.out.includes(SECRET)) {
                        bad.push(`${name} ${rel}: code ${r.code}; out ${JSON.stringify(r.out.slice(0, 200))}; err ${JSON.stringify(r.err.slice(0, 160))}`)
                    }
                }
                assert.deepEqual(fs.readdirSync(dir).sort(), before, `${name}: 未建任何檔`)
            }
            assert.deepEqual(bad, [])
        })

        it('對照(合法之設定不受影響): 參考設定之專案根 ⇒ 不印 ERROR invalid settings / 無法讀取專案設定(其後之結果依各入口; 本案只核對讀設定這一關通過)', () => {
            let dir = mkRoot('ok', (fp) => fs.writeFileSync(fp, JSON.stringify({ ...base(), resources: {} }), 'utf8'))
            //只取不派工、不連網、不建帳本之唯讀工具(improveTrend、waitEvent)
            for (let [rel, args, env] of ENTRIES.filter((e) => ['src/tools/waitEvent.mjs', 'src/tools/improveTrend.mjs'].includes(e[0]))) {
                //waitEvent 無事件檔會等待至逾時 ⇒ 給短之 --timeout-min
                let a = rel.endsWith('waitEvent.mjs') ? ['--timeout-min', '0.01', '--poll-sec', '2'] : args
                let r = run(rel, a, dir, env)
                assert(!/無法讀取專案設定|ERROR invalid settings/.test(r.out), `${rel}: ${r.out.slice(0, 300)}`)
            }
        })
    })
})
