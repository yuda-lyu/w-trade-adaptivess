import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { isBuiltin } from 'module'
import WTradeAdaptivess from '../src/WTradeAdaptivess.mjs'
import { initProject, renderContract, shimOf, MARK, CLIS } from '../src/tools/initProject.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//套件結構與專案接入之守門(sgud/rule/rulebook.md 之 R-PKG-1 ~ R-PKG-5): 每條斷言對應規則之一句
//  ① 發布面: scripts 只有 test 與 deploy; 不設 exports / files / type; main 指 dist 之 UMD
//  ② 依賴對帳: src/ 實際 import 之 npm 套件 = dependencies; 自有套件一律以 src 深層路徑引用; node 內建模組不帶 node: 前綴
//  ③ 專案根之錨點: cfg.mjs 之 FD_ROOT = 環境變數 ARSI_ROOT, 未設時為工作目錄; 進入檔設定 ARSI_ROOT 後才載入命令列程式(與工作目錄無關)
//  ④ 專案接入 initProject: 產生進入檔與參考檔; 非本工具所產生之同名檔不覆寫(--force 才覆寫); settings.json 與 arms/base.json 只在不存在時寫; 重跑不變
//  ⑤ 發布內容不含宿主之痕跡(通則檢查): 磁碟機絕對路徑(測試之示意路徑除外)、家目錄路徑、內網位址; 使用端之名稱不列於本庫(由發布前之外部去識別檢查負責)
let read = (rel) => fs.readFileSync(path.join(FD_ROOT, rel), 'utf8')
let walk = (dir, out = []) => {
    for (let f of fs.readdirSync(dir, { withFileTypes: true })) {
        let fp = path.join(dir, f.name)
        if (f.isDirectory()) {
            if (!['node_modules', '_tmp', 'dist', 'docs'].includes(f.name)) {
                walk(fp, out)
            }
        }
        else {
            out.push(fp)
        }
    }
    return out
}
let relOf = (fp) => path.relative(FD_ROOT, fp).replace(/\\/g, '/')
let pkg = JSON.parse(read('package.json'))
//installed: 套件夾既無 .git 亦無 .gitignore ⇒ 安裝後或解開之 npm 包(npm 預設不收 .gitignore, 包內之檔 = 已發布之內容)。
//  此時以 .gitignore 為對象之檢查(列項)改略過並說明, 以 .gitignore 定掃描範圍者改以包內之全部文字檔為範圍(不含 node_modules 與測試自己產生之暫存夾);
//  repo 內(有 .git 或 .gitignore)之檢查不變 —— 有 .git 而缺 .gitignore 時仍讀檔失敗, 不因本旗標放寬
let installed = !fs.existsSync(path.join(FD_ROOT, '.git')) && !fs.existsSync(path.join(FD_ROOT, '.gitignore'))

describe('套件:發布面與依賴', function () {
    it('package.json:scripts 只有 test 與 deploy;不設 exports / files / type;main 指 dist 之 UMD;test 指令為規定之字串', () => {
        //R-PKG-1
        assert.deepEqual(Object.keys(pkg.scripts).sort(), ['deploy', 'test'])
        assert.equal(pkg.scripts.test, 'mocha --no-parallel "test/*.test.mjs" --timeout 180000')
        assert(pkg.exports === undefined && pkg.files === undefined && pkg.type === undefined)
        assert.equal(pkg.main, 'dist/w-trade-adaptivess.umd.js')
        assert(!fs.existsSync(path.join(FD_ROOT, '.mocharc.json')) && !fs.existsSync(path.join(FD_ROOT, '.npmignore')))
    })

    it('.gitignore:列 node_modules、tmp 等;不得排除 sgud / src / test(npm 包不含 .gitignore ⇒ 於包內略過)', function () {
        //R-PKG-1; 套件夾既無 .git 亦無 .gitignore(npm 包)⇒ 無從檢查, 略過; repo 內缺 .gitignore 者(有 .git)照舊失敗
        if (installed) {
            this.skip()
        }
        let gi = read('.gitignore').split(/\r?\n/)
        for (let x of ['node_modules', 'tmp', 'test/_tmp', 'CLAUDE*.md', 'rsi', 'data']) {
            assert(gi.includes(x), `.gitignore 須列 ${x}`)
        }
        assert(!gi.some((l) => /sgud|^src|^test$/.test(l)), '.gitignore 不得排除 sgud / src / test')
    })

    it('src 實際 import 之 npm 套件 = dependencies;自有套件以 src 深層路徑引用;node 內建模組不帶 node: 前綴', () => {
        //R-PKG-2
        let bare = new Map()
        for (let fp of walk(path.join(FD_ROOT, 'src')).filter((f) => /\.mjs$/.test(f))) {
            let s = fs.readFileSync(fp, 'utf8')
            for (let m of s.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n;]*?\bfrom\s*(['"])([^'"\n]+)\1/g)) {
                let spec = m[2]
                if (!spec.startsWith('.')) {
                    bare.set(spec, relOf(fp))
                }
            }
        }
        let npm = new Set()
        for (let [spec, at] of bare) {
            assert(!spec.startsWith('node:'), `${at} 之 ${spec} 不得帶 node: 前綴`)
            if (isBuiltin(spec)) {
                continue
            }
            let name = spec.split('/')[0]
            npm.add(name)
            assert(new RegExp(`^${name}/src/`).test(spec), `${at}: 自有套件 ${name} 須以 src 深層路徑引用(收到 ${spec})`)
        }
        assert.deepEqual([...npm].sort(), Object.keys(pkg.dependencies).sort())
    })

    it('聚合入口:每個鍵皆有值;總組裝之別名為同一實體;命令列程式與工具不在其內', () => {
        //src/WTradeAdaptivess.mjs 檔頭
        for (let [k, v] of Object.entries(WTradeAdaptivess)) {
            assert(v !== undefined && v !== null, `聚合入口之 ${k} 無值`)
        }
        assert.equal(WTradeAdaptivess.createAdaptivess, WTradeAdaptivess.makeProject)
        for (let k of ['makeProject', 'buildLedger', 'loadLedger', 'makeEvaluator', 'loadPick', 'scoreOf', 'createArsi', 'createFileRecords', 'createToolbox', 'makeDispatch', 'runRounds', 'initProject', 'getSettings', 'setGuardExtra', 'guardExtraOf']) {
            assert.equal(typeof WTradeAdaptivess[k], 'function', k)
        }
    })

    it('聚合入口之站點全集(R-PKG-7;排程第 500 項):79 鍵(函數 63、常數 16;基礎單位之 isCapitalError、normUnit、sameUnit 併入);memberLedger 併入且與 ledger.mjs 之匯出為同一實體;tieBaseOf、isSrcIdx 不併入(以 ESM 深層路徑取用)', async () => {
        let keys = Object.keys(WTradeAdaptivess)
        assert.equal(keys.length, 79)
        assert.equal(keys.filter((k) => typeof WTradeAdaptivess[k] === 'function').length, 63)
        assert.equal(keys.filter((k) => typeof WTradeAdaptivess[k] !== 'function').length, 16)
        let ledgerMod = await import('../src/eval/ledger.mjs')
        assert.equal(WTradeAdaptivess.memberLedger, ledgerMod.memberLedger)
        assert.equal(typeof WTradeAdaptivess.memberLedger, 'function')
        //聚合入口之每個鍵 = 其來源模組之同名匯出(與各模組之匯出為同一實體): 評估器相關者逐一核對
        assert.equal(WTradeAdaptivess.loadLedger, ledgerMod.loadLedger)
        assert.equal(WTradeAdaptivess.loadIds, ledgerMod.loadIds)
        for (let k of ['tieBaseOf', 'isSrcIdx']) {
            assert.equal(k in WTradeAdaptivess, false, `${k} 不併入聚合入口`)
            assert.equal(typeof ledgerMod[k], 'function', `${k} 仍可由深層路徑取用`)
        }
        //每個函數鍵於其定義處有 JSDoc 之 @example(R-PKG-7): memberLedger 之 JSDoc 含 @example
        let src = fs.readFileSync(path.join(FD_ROOT, 'src', 'eval', 'ledger.mjs'), 'utf8')
        let jd = /\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*let memberLedger = /.exec(src)
        assert(jd && /@param \{Object\} L/.test(jd[1]) && /@returns/.test(jd[1]) && /@example/.test(jd[1]), 'memberLedger 之 JSDoc 含 @param、@returns、@example')
    })
})

describe('套件:專案根之錨點與專案接入', function () {
    let t
    beforeEach(() => {
        t = makeTmp('package')
    })
    afterEach(() => {
        t.cleanup()
    })
    let fpCfg = path.join(FD_ROOT, 'src', 'cfg.mjs').replace(/\\/g, '/')

    it('cfg.mjs 之專案根 = 環境變數 ARSI_ROOT;未設時為行程之工作目錄(不以套件檔之位置推導)', () => {
        //R-PKG-3
        let other = path.join(t.dir, 'projA')
        fs.mkdirSync(other, { recursive: true })
        let env0 = { ...process.env }
        delete env0.ARSI_ROOT
        let run = (env, cwd) => {
            let r = spawnSync(process.execPath, ['--input-type=module', '-e', `import('file:///${fpCfg}').then((m) => console.log(m.FD_ROOT))`], { cwd, env, windowsHide: true, encoding: 'utf8' })
            return path.resolve(String(r.stdout).trim())
        }
        assert.equal(run({ ...env0, ARSI_ROOT: other }, FD_ROOT), path.resolve(other))
        assert.equal(run(env0, other), path.resolve(other))
        assert.notEqual(run(env0, other), path.resolve(FD_ROOT), '不得落在套件夾(以檔案位置推導之結果)')
    })

    it('進入檔:設定 ARSI_ROOT 為自身所在之資料夾後才載入命令列程式 —— 自其他工作目錄執行亦以進入檔之資料夾為專案根', () => {
        //R-PKG-3: 套件根之六個進入檔與 initProject 所產生者同形(只差匯入路徑)
        for (let c of CLIS) {
            let s = read(`g_${c}.mjs`)
            assert(/process\.env\.ARSI_ROOT = path\.dirname\(fileURLToPath\(import\.meta\.url\)\)/.test(s) && s.includes(`await import('./src/cli/${c}.mjs')`), `g_${c}.mjs`)
            assert(s.indexOf('process.env.ARSI_ROOT') < s.indexOf('await import('), '須先設定專案根再載入')
            assert(!/^import .*src\//m.test(s), '進入檔不得靜態匯入套件之程式(靜態匯入先於設定專案根)')
        }
        //自暫存夾執行套件根之 g_eval.mjs(不給 --pick ⇒ 印用法、離開碼 2): 須讀得到套件根之 settings.json(專案根 = 進入檔之資料夾, 非工作目錄)
        let env0 = { ...process.env }
        delete env0.ARSI_ROOT
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'g_eval.mjs')], { cwd: t.dir, env: env0, windowsHide: true, encoding: 'utf8' })
        assert.equal(r.status, 2, String(r.stderr).slice(0, 300))
        assert(String(r.stdout).includes('用法: node g_eval.mjs --pick'))
    })

    it('initProject:產生進入檔與參考檔;重跑不變;非本工具所產生之同名檔不覆寫(force 才覆寫);settings.json 與 arms/base.json 只在不存在時寫;專案根不可為套件夾', () => {
        //R-PKG-4
        let root = path.join(t.dir, 'proj')
        fs.mkdirSync(path.join(root, 'tools'), { recursive: true })
        fs.writeFileSync(path.join(root, 'g_eval.mjs'), '//專案原有之檔\n')
        fs.writeFileSync(path.join(root, 'tools', 'waitEvent.mjs'), '//專案原有之工具\n')
        fs.writeFileSync(path.join(root, 'tools', 'mine.mjs'), '//專案自有\n')
        fs.writeFileSync(path.join(root, 'settings.json'), '{"name":"mine"}')
        //合約之參考版依專案之設定產出(規則 R-REC-36; 本例之設定未給求解窗與保留期之起點 ⇒ 該兩處為通稱)
        let refC = renderContract(read('contract/pick-contract.md'), { settings: { name: 'mine' } })
        let dry = initProject({ root, dry: true })
        assert(dry.written.includes('g_rsi.mjs') && !fs.existsSync(path.join(root, 'g_rsi.mjs')), 'dry 只列出、不寫')
        let r1 = initProject({ root })
        assert.deepEqual(r1.skipped.sort(), ['g_eval.mjs', 'tools/waitEvent.mjs'])
        assert.equal(fs.readFileSync(path.join(root, 'g_eval.mjs'), 'utf8'), '//專案原有之檔\n')
        assert(r1.kept.includes('settings.json') && fs.readFileSync(path.join(root, 'settings.json'), 'utf8') === '{"name":"mine"}')
        for (let c of CLIS.filter((x) => x !== 'eval')) {
            let s = fs.readFileSync(path.join(root, `g_${c}.mjs`), 'utf8')
            assert.equal(s, shimOf(`w-trade-adaptivess/src/cli/${c}.mjs`, 0))
            assert(s.startsWith(MARK) && s.includes('process.env.ARSI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))'))
        }
        let tool = fs.readFileSync(path.join(root, 'tools', 'fakeRound.mjs'), 'utf8')
        assert(tool.includes('path.resolve(path.dirname(fileURLToPath(import.meta.url)), \'..\')') && tool.includes('await import(\'w-trade-adaptivess/src/tools/fakeRound.mjs\')'))
        assert(!fs.existsSync(path.join(root, 'tools', 'initProject.mjs')), '本工具自身不產生進入檔')
        assert.equal(fs.readFileSync(path.join(root, 'tools', 'mine.mjs'), 'utf8'), '//專案自有\n')
        assert.equal(fs.readFileSync(path.join(root, 'docs', 'pick-contract.md'), 'utf8'), refC)
        assert.equal(fs.readFileSync(path.join(root, 'arms', 'base.json'), 'utf8'), read('arms/base.json'))
        assert(fs.existsSync(path.join(root, 'examples', 'pick_example.mjs')))
        //每個套件工具皆有進入檔
        let tools = fs.readdirSync(path.join(FD_ROOT, 'src', 'tools')).filter((f) => f !== 'initProject.mjs')
        assert(tools.length >= 15 && tools.every((f) => fs.existsSync(path.join(root, 'tools', f))))
        //重跑: 無新寫入
        let r2a = initProject({ root })
        assert.deepEqual([r2a.written, r2a.differs], [[], []])
        //專案改過之 arms/base.json 與合約不被覆寫; 合約與參考版不同 ⇒ 另寫參考版 docs/pick-contract.pkg.md 並列出; 專案把合約改回與參考版相同後, 參考版之副本移除
        fs.writeFileSync(path.join(root, 'arms', 'base.json'), '{"mine":true}')
        fs.writeFileSync(path.join(root, 'docs', 'pick-contract.md'), '專案之合約(含自己之數值)')
        let r2 = initProject({ root })
        assert.deepEqual([r2.written, r2.differs], [['docs/pick-contract.pkg.md'], ['docs/pick-contract.md']])
        assert.equal(fs.readFileSync(path.join(root, 'docs', 'pick-contract.md'), 'utf8'), '專案之合約(含自己之數值)')
        assert.equal(fs.readFileSync(path.join(root, 'docs', 'pick-contract.pkg.md'), 'utf8'), refC)
        assert.equal(fs.readFileSync(path.join(root, 'arms', 'base.json'), 'utf8'), '{"mine":true}')
        fs.writeFileSync(path.join(root, 'docs', 'pick-contract.md'), refC)
        assert.deepEqual(initProject({ root }).differs, [])
        assert(!fs.existsSync(path.join(root, 'docs', 'pick-contract.pkg.md')))
        //force: 覆寫非本工具所產生之進入檔
        let r3 = initProject({ root, force: true })
        assert.deepEqual(r3.written.sort(), ['g_eval.mjs', 'tools/waitEvent.mjs'])
        assert(fs.readFileSync(path.join(root, 'g_eval.mjs'), 'utf8').startsWith(MARK) && r3.skipped.length === 0)
        assert.throws(() => initProject({ root: FD_ROOT }), /套件夾本身/)
    })
})

describe('套件:發布內容不含宿主之痕跡', function () {
    //R-PKG-5: 只做「通則」之檢查(本機路徑、內網位址與主機名), 不列任何使用端之名稱 —— 名單本身寫進公開庫即是洩漏; 使用端名稱與帳號由發布前之外部去識別檢查負責
    //  掃描範圍 = 版控與 npm 包之內容: 套件根之全部檔(含本檔與建置產物 dist、docs), 依 .gitignore 略過版控所排除者(執行時讀取, 不另抄一份清單)與 .git;
    //    文字檔以內容判別(前 8 KB 無 NUL 位元組), 不以副檔名
    //  installed(npm 包; 無 .gitignore)者以 INSTALLED_SKIP 代之: 包內之檔本即已發布之內容, 只略過安裝時帶入之 node_modules(任一層)與測試自己產生之暫存夾(只認包根下之路徑;
    //  前導 / 者錨定於包根 —— 不帶斜線之名稱會比對任一路徑段, 已發布之 src/tmp/ 之類即被略過而漏查)
    let INSTALLED_SKIP = ['node_modules', '/tmp', 'test/_tmp', '/testPending', '/_test_adaptivess']
    let ignoredOf = (lines = installed ? INSTALLED_SKIP : read('.gitignore').split(/\r?\n/)) => {
        let rules = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!')).map((r) => {
            let g = r.replace(/^\//, '').replace(/\/$/, '')
            return { anchored: r.includes('/'), re: new RegExp(`^${g.split('*').map((x) => x.replace(/[.+?^$()|[\]\\{}]/g, '\\$&')).join('[^/]*')}$`) }
        })
        //anchored(含 /)者自套件根比對路徑之前綴; 其餘比對路徑之任一段(同 .gitignore 之語意)
        return (rel) => {
            let parts = rel.split('/')
            return parts[0] === '.git' || rules.some(({ anchored, re }) => (anchored ? parts.some((_, i) => re.test(parts.slice(0, i + 1).join('/'))) : parts.some((p) => re.test(p))))
        }
    }
    //textOf, 檔案之文字內容: UTF-16(有 BOM)者依其編碼解碼; 其餘前 8 KB 有 NUL 位元組者視為二進位(回 null), 否則以 UTF-8 解碼
    let textOf = (fp) => {
        let b = fs.readFileSync(fp)
        if (b[0] === 0xff && b[1] === 0xfe) {
            return b.subarray(2).toString('utf16le')
        }
        if (b[0] === 0xfe && b[1] === 0xff) {
            let sw = Buffer.from(b.subarray(2))
            sw.swap16()
            return sw.toString('utf16le')
        }
        return b.subarray(0, 8192).includes(0) ? null : b.toString('utf8')
    }
    //listPub, 掃描之檔: 套件夾內有 .git 者以 git 之清單為準(已追蹤 + 未追蹤而未被忽略 = git add -A 之範圍; 含否定、目錄限定、子資料夾之 .gitignore 等全部語意);
    //  無 .git(如安裝後之套件夾)或 git 不可用者, 退回以本檔之簡化規則讀 .gitignore(`*` 萬用字元、含 / 者錨定於套件根)
    let listPub = () => {
        if (fs.existsSync(path.join(FD_ROOT, '.git'))) {
            let r = spawnSync('git', ['-C', FD_ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], { windowsHide: true, encoding: 'utf8' })
            if (r.status === 0 && r.stdout) {
                return r.stdout.split('\0').filter(Boolean).map((rel) => path.join(FD_ROOT, rel)).filter((fp) => fs.existsSync(fp) && textOf(fp) !== null)
            }
        }
        let ignored = ignoredOf()
        let out = []
        let walkPub = (dir) => {
            for (let f of fs.readdirSync(dir, { withFileTypes: true })) {
                let fp = path.join(dir, f.name)
                if (ignored(relOf(fp))) {
                    continue
                }
                if (f.isDirectory()) {
                    walkPub(fp)
                }
                else if (textOf(fp) !== null) {
                    out.push(fp)
                }
            }
        }
        walkPub(FD_ROOT)
        return out
    }
    //測試之示意路徑(假想之磁碟機路徑, 非本機實際之位置): 只豁免示意根本身或其下之路徑(名稱須到分隔符或結尾為止)
    let DEMO = /D:[\\/]+(?:demo-strategy-lib|projHalf)(?=[\\/'"`\s]|$)/gm
    //home, 本機之使用者家目錄(執行時取得; 兩種分隔符皆比對)
    let home = os.homedir()
    let esc = (x) => x.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')
    let homesOf = (h) => [...new Set([h, h.replace(/\\/g, '/')])].filter((x) => x.length >= 4).map((x) => esc(x.toLowerCase()))
    let privIp = (a, b) => a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    //tracesOf, 找出一段文字內之宿主痕跡(hs = 家目錄之正規式字串陣列, 預設為本機; js = 是否為 JS / JSON 之原始碼):
    //  磁碟機絕對路徑(前一字元不得為字母數字、斜線或點 —— 排除正規式內之 \/C: 之類)、file URL 之本機路徑、POSIX 形式之家目錄路徑、
    //  UNC 分享(JS / JSON 之字串內須跳脫, 故只認四個反斜線之寫法 —— 兩個反斜線在其中是正規式之 \b、\s 等; 其他文字檔認原文之兩個反斜線)、
    //  內網主機名(.internal、.intranet、.corp、.lan、.ts.net、.home.arpa)、本機家目錄、私有網段(RFC 1918、CGNAT 100.64/10、鏈結本地)之 IPv4 位址(有無埠皆算; 前一字元為字母數字或點者如 v10.1.2.3 不算)
    let tracesOf = (text, hs = homesOf(home), { js = false } = {}) => {
        //示意路徑以佔位字取代(不直接刪除: 刪除後其下之路徑段會緊接引號而被當成 UNC)
        let s = text.replace(DEMO, '<示意路徑>')
        let out = []
        let rules = [
            ['磁碟機絕對路徑', /(?<![\w\\/.])[A-Za-z]:[\\/]{1,2}[^\s'"`<>|*?:()[\]{},;]+/],
            ['file URL 之本機路徑', /file:\/\/(?:localhost)?\/(?:[A-Za-z]:|[A-Za-z0-9._~-]+\/)/i],
            ['家目錄路徑', /(?:^|[\s'"`(=])\/(?:[A-Za-z]\/)?(?:Users|home)\/[^\s\\/'"`)]+/m],
            ['UNC 分享', js ? /(?:^|[\s'"`(=])\\\\\\\\[A-Za-z0-9][\w.-]*\\\\[\w$.-]+/m : /(?:^|[\s'"`(=])\\\\[A-Za-z0-9][\w.-]*\\[\w$.-]+/m],
            ['內網主機名', /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:internal|intranet|corp|lan|ts\.net|home\.arpa)\b/i],
        ]
        for (let [label, re] of rules) {
            let m = s.match(re)
            if (m) {
                out.push(`${label} ${m[0].trim()}`)
            }
        }
        let low = s.toLowerCase()
        for (let h of hs) {
            if (new RegExp(`(?<![\\w.])${h}(?=[\\\\/'"\`\\s,;:)\\]}>]|$)`, 'm').test(low)) {
                out.push('本機家目錄')
            }
        }
        for (let ip of s.matchAll(/(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d)/g)) {
            let ns = ip.slice(1, 5).map(Number)
            if (ns.every((n) => n <= 255) && privIp(ns[0], ns[1])) {
                out.push(`私有網段位址 ${ip[0]}`)
            }
        }
        return out
    }

    it('檢查本身:各類宿主痕跡皆被指出,示意路徑、公開網址、版本字串、本機迴路與正規式內之字樣不誤判;家目錄之分支單獨驗證', () => {
        //樣本於執行時組出, 本檔原文不含任何真實之痕跡
        let bs = '\\'
        let drive = ['C', ':', bs, 'work', bs, 'proj', bs, 'a.mjs'].join('')
        let ip = (...xs) => xs.join('.')
        let bad = [
            drive,
            drive.replace(/\\/g, '/'),
            ['C', ':', bs, 'secret.txt'].join(''),
            ['', 'c', 'Users', 'someone', 'x'].join('/'),
            ['', 'home', 'someone', 'x'].join('/'),
            ['', 'home', 'other-user'].join('/'),
            ['file:', '', '', 'home', 'other-user', 'data'].join('/'),
            ['file:', '', '', ['C', ':'].join(''), 'x'].join('/'),
            ['file:', '', '', 'etc', 'company', 'secret.conf'].join('/'),
            ['file:', '', 'localhost', 'srv', 'private', 'data'].join('/'),
            path.join(home, 'proj'),
            ['D', ':', '/', 'demo-strategy-library', '/', 'secret.txt'].join(''),
            ['', '', 'internal-host', 'share', 'secret'].join(bs),
            ['', '', '3server', 'share', 'secret'].join(bs),
            ['https://git.company', 'internal/private/repo'].join('.'),
            `http://${ip('10', '1', '2', '3')}/`,
            `${ip('192', '168', '0', '5')}:8080`,
            ip('172', '20', '1', '1'),
            `${ip('100', '100', '1', '2')}:4873`,
            ip('169', '254', '1', '1'),
        ]
        for (let x of bad) {
            assert(tracesOf(`前文 ${x} 後文`).length > 0, `應指出: ${x}`)
        }
        let good = [
            ['D', ':', '/', 'demo-strategy-lib', '/', 'data'].join(''),
            ['D', ':', bs, 'projHalf', bs, 'rsi'].join(''),
            'https://github.com/yuda-lyu/w-trade-adaptivess',
            'http://img.shields.io/npm/v/w-trade-adaptivess.svg',
            'w-recursi ^1.0.10、node >=24.11.0',
            `release v${ip('10', '1', '2', '3')}`,
            ip('127', '0', '0', '1'),
            ip('8', '8', '8', '8'),
            ip('172', '32', '0', '1'),
            'path.join(os.homedir(), ".claude", "skills")',
            `if (/^${bs}/${['C', ':'].join('')}/i.test(t)) {`,
            'import(\'file:///\' + fp)',
        ]
        for (let x of good) {
            assert.deepEqual(tracesOf(`前文 ${x} 後文`), [], `不應誤判: ${x}`)
        }
        //JS / JSON 原始碼: UNC 只認跳脫形(四個反斜線); 字串內之正規式(\\b、\\s)不誤判
        let uncJs = `'${['', '', '', '', 'internal-host', '', 'share'].join(bs)}'`
        assert(tracesOf(`let p = ${uncJs}`, undefined, { js: true }).length > 0, `應指出: ${uncJs}`)
        let reJs = `new RegExp(\`${bs}${bs}bimport${bs}${bs}s*${bs}${bs}(\`)`
        assert.deepEqual(tracesOf(reJs, undefined, { js: true }), [], `不應誤判: ${reJs}`)
        //無 v 前綴之四段數字(如 release 後接一個落在私有網段之四段版本號)無從與位址區分 ⇒ 依「衝突收嚴」列出(寧可報出由人核對)
        assert(tracesOf(`release ${ip('10', '1', '2', '3')}`).length > 0)
        //家目錄之分支: 以不被其他規則辨識之假家目錄單獨驗證(給了才指出, 不給即不指出; 尾端之標點不影響; 相似名稱不算)
        let fake = ['', 'srv', 'acct-x'].join('/')
        assert.deepEqual(tracesOf(`前文 ${fake}/y 後文`, homesOf(fake)), ['本機家目錄'])
        assert.deepEqual(tracesOf(`前文 ${fake}/y 後文`, []), [])
        for (let x of [`${fake},`, `(${fake})`, `${fake}:`]) {
            assert.deepEqual(tracesOf(`前文 ${x} 後文`, homesOf(fake)), ['本機家目錄'], `應指出: ${x}`)
        }
        assert.deepEqual(tracesOf(`前文 ${fake}yz/file 後文`, homesOf(fake)), [], '相似名稱不算')
    })

    it('檢查本身:npm 包內之掃描範圍(INSTALLED_SKIP)—— 只略過任一層之 node_modules 與包根下之暫存夾;已發布之同名子夾(如 src/tmp/)仍在範圍內', () => {
        //Gitea #154 外審之補格: 不帶斜線之名稱會比對任一路徑段, 曾使已發布之 src/tmp/ 、docs/testPending/ 漏查
        let skip = ignoredOf(INSTALLED_SKIP)
        for (let r of ['node_modules/a/b.js', 'docs/node_modules/x.txt', 'tmp/wta/a.txt', 'test/_tmp/c/a.txt', 'testPending/x.png', '_test_adaptivess/a.json', '.git/config']) {
            assert.equal(skip(r), true, `應略過 ${r}`)
        }
        for (let r of ['src/tmp/a.txt', 'docs/testPending/n.md', 'src/domain/_test_adaptivess/a.json', 'test/unit-package.test.mjs', 'src/WTradeAdaptivess.mjs', 'sgud/state/state.md']) {
            assert.equal(skip(r), false, `應在範圍內 ${r}`)
        }
    })

    it('檢查本身:UTF-16(有 BOM)之文字檔依其編碼讀取;二進位檔略過', () => {
        let t = makeTmp('packageText')
        try {
            let drive = ['C', ':', '\\', 'work', '\\', 'x.txt'].join('')
            let fp16 = path.join(t.dir, 'notes-utf16.txt')
            fs.writeFileSync(fp16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`備註 ${drive}`, 'utf16le')]))
            assert(tracesOf(textOf(fp16)).length > 0, 'UTF-16LE')
            let be = Buffer.from(`備註 ${drive}`, 'utf16le')
            be.swap16()
            let fp16be = path.join(t.dir, 'notes-utf16be.txt')
            fs.writeFileSync(fp16be, Buffer.concat([Buffer.from([0xfe, 0xff]), be]))
            assert(tracesOf(textOf(fp16be)).length > 0, 'UTF-16BE')
            let fpBin = path.join(t.dir, 'a.bin')
            fs.writeFileSync(fpBin, Buffer.from([1, 0, 2, 3]))
            assert.strictEqual(textOf(fpBin), null)
        }
        finally {
            t.cleanup()
        }
    })

    it('版控與 npm 包之全部文字檔(含建置產物 dist、docs)不含本機路徑(磁碟機、file URL、家目錄、UNC;測試之示意路徑除外)、內網主機名與私有網段位址', () => {
        let files = listPub()
        let rels = new Set(files.map(relOf))
        //範圍未壞: 代表檔皆在內(掃描回空不算通過); 版控所排除者不在內
        for (let x of ['package.json', 'README.md', 'LICENSE', 'settings.json', 'script.txt', ...(installed ? [] : ['.gitignore']), '.jsdoc', 'src/WTradeAdaptivess.mjs', 'src/cfg.mjs', 'test/unit-package.test.mjs', 'test/tools/synthLedger.mjs', 'sgud/state/state.md', 'contract/pick-contract.md', 'arms/base.json', 'examples/pick_example.mjs', 'toolg/gDistRollup.mjs', 'g_eval.mjs']) {
            assert(rels.has(x), `掃描範圍須含 ${x}`)
        }
        if (fs.existsSync(path.join(FD_ROOT, 'dist', 'w-trade-adaptivess.umd.js'))) {
            assert(rels.has('dist/w-trade-adaptivess.umd.js') && rels.has('dist/w-trade-adaptivess.umd.js.map'), '建置產物存在時須在掃描範圍內')
        }
        assert(![...rels].some((r) => /^(node_modules|tmp|test\/_tmp)\//.test(r) || /(^|\/)CLAUDE[^/]*\.md$/.test(r)), '版控所排除者不得在掃描範圍內')
        let hits = []
        for (let fp of files) {
            for (let h of tracesOf(textOf(fp), undefined, { js: /\.(mjs|cjs|js|json|map)$/i.test(fp) })) {
                hits.push(`${relOf(fp)}: ${h}`)
            }
        }
        assert.deepEqual(hits, [])
    })
})
