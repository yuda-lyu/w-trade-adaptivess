import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { getSettings } from '../src/cfg.mjs'
import { makeTexts as makeTextsEsm } from '../src/domain/texts.mjs'
import { initProject as initProjectEsm } from '../src/tools/initProject.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//以檔案位置定位套件內之夾者,打包成單檔(dist/*.umd.js)後之行為(排程第 477 項 ②; 規則 R-PKG-11):
//  打包後各模組之 import.meta.url 皆指向 dist 內之打包檔 ⇒ 依檔案位置推導(src/domain、src)得 dist,任務書所寫之「不得讀取 / 不得改」之程式夾即錯;
//  改「往上找本套件之 package.json」(pkgRootOf): 原始檔(<套件根>/src/domain)與打包檔(<套件根>/dist/…)皆得同一個套件根
//  (各案內才動態匯入新模組 ⇒ 於修前之複本中各案各自失敗, 不因一個匯入錯誤使整檔無從區分)
describe('pkgRootOf:往上找本套件之 package.json;打包檔之定位(排程第 477 項 ②)', function () {
    this.timeout(180000)
    let t
    before(() => {
        t = makeTmp('pkgRoot')
    })
    after(() => {
        t.cleanup()
    })
    let pk = () => import('../src/domain/pkgRoot.mjs')
    let mk = (rel, pkg = null) => {
        let d = path.join(t.dir, rel)
        fs.mkdirSync(d, { recursive: true })
        if (pkg !== null) {
            fs.writeFileSync(path.join(d, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg), 'utf8')
        }
        return d
    }

    it('pkgRootOf: 自原始檔之夾(src/domain)與打包檔之夾(dist、dist/umd)往上皆得同一個套件根;套件裝於 node_modules/<套件名>/ 者(外層另有他名之 package.json)得套件夾而非外層專案', async () => {
        let { pkgRootOf, PKG_NAME } = await pk()
        let root = mk('a', { name: PKG_NAME, version: '1.0.0' })
        for (let d of ['src/domain', 'dist', 'dist/umd', 'src']) {
            assert.equal(pkgRootOf(mk(`a/${d}`)), root, d)
        }
        assert.equal(pkgRootOf(root), root, '自套件根本身')
        let proj = mk('proj', { name: 'some-project' })
        let inst = mk('proj/node_modules/w-trade-adaptivess', { name: PKG_NAME })
        assert.equal(pkgRootOf(mk('proj/node_modules/w-trade-adaptivess/src/domain')), inst)
        assert.equal(pkgRootOf(mk('proj/node_modules/w-trade-adaptivess/dist')), inst)
        assert.notEqual(pkgRootOf(mk('proj/node_modules/w-trade-adaptivess/dist')), proj, '不取外層專案')
        assert.equal(PKG_NAME, 'w-trade-adaptivess')
    })

    it('pkgRootOf: 沿途他名之 package.json 略過、讀不出之 package.json(壞 JSON、空檔、目錄)略過;往上找不到(給了不存在之套件名)⇒ null', async () => {
        let { pkgRootOf, PKG_NAME } = await pk()
        let root = mk('b', { name: PKG_NAME })
        mk('b/mid', { name: 'other' })
        mk('b/mid/bad', '{ not json')
        mk('b/mid/bad/empty', '')
        assert.equal(pkgRootOf(path.join(t.dir, 'b', 'mid', 'bad', 'empty')), root, '他名與壞 JSON 皆略過')
        fs.mkdirSync(path.join(t.dir, 'b', 'dirpkg', 'package.json'), { recursive: true })
        assert.equal(pkgRootOf(path.join(t.dir, 'b', 'dirpkg')), root, 'package.json 為目錄者略過')
        assert.equal(pkgRootOf(path.join(t.dir, 'b', 'mid'), 'other'), path.join(t.dir, 'b', 'mid'), '給另一個套件名 ⇒ 依其找')
        assert.strictEqual(pkgRootOf(path.join(t.dir, 'b', 'mid'), 'no-such-package-name'), null, '找不到 ⇒ null')
    })

    it('fillKeys 之 SRC(評估器原始碼之夾): 有本套件之 package.json 者以套件根下之 src 為準 —— 原始檔、打包檔(dist)、更深之打包檔(dist/umd)皆同一個指紋、隨原始碼而變;找不到套件根者依檔案位置推導(原作法)', async () => {
        let { PKG_NAME } = await pk()
        let mkLayout = (name, dd) => {
            let root = mk(name, { name: PKG_NAME })
            for (let x of [dd, 'src/eval', 'src/cli']) {
                fs.mkdirSync(path.join(root, x), { recursive: true })
            }
            for (let f of ['fillKeys.mjs', 'fillPlan.mjs', 'evalVersion.mjs', 'pkgRoot.mjs']) {
                fs.copyFileSync(new URL(`../src/domain/${f}`, import.meta.url), path.join(root, dd, f))
            }
            fs.writeFileSync(path.join(root, 'src', 'eval', 'a.mjs'), 'export default 1\n', 'utf8')
            fs.writeFileSync(path.join(root, 'src', 'cli', 'eval.mjs'), 'export default 2\n', 'utf8')
            return root
        }
        let FK = async (root, dd) => import(pathToFileURL(path.join(root, dd, 'fillKeys.mjs')).href)
        let rS = mkLayout('fkSrc', 'src/domain')
        let rD = mkLayout('fkDist', 'dist')
        let rU = mkLayout('fkUmd', 'dist/umd')
        let fp0 = (await FK(rS, 'src/domain')).evaluatorFpOf({})
        assert(/^ev-[0-9a-f]{20}$/.test(fp0), fp0)
        assert.equal((await FK(rD, 'dist')).evaluatorFpOf({}), fp0, 'dist')
        //更深之打包檔: 依檔案位置推導(上一層為 dist)找不到 eval/ ⇒ 讀不到評估器之原始碼; 往上找 package.json 得套件根
        assert.equal((await FK(rU, 'dist/umd')).evaluatorFpOf({}), fp0, 'dist/umd')
        assert.equal((await FK(rU, 'dist/umd')).srcDirOf(path.join(rU, 'dist', 'umd')), path.join(rU, 'src'))
        //原作法(找不到套件根: 給不存在之套件名): 本檔位於 src/domain ⇒ 上一層即 src; 位於套件根下一層之打包檔 ⇒ 上一層為套件根, 其 src/eval
        let fk = await FK(rS, 'src/domain')
        assert.equal(fk.srcDirOf(path.join(rS, 'src', 'domain'), 'no-such-package-name'), path.join(rS, 'src'), '原作法: src/domain')
        assert.equal(fk.srcDirOf(path.join(rD, 'dist'), 'no-such-package-name'), path.join(rD, 'src'), '原作法: dist')
        fs.writeFileSync(path.join(rU, 'src', 'eval', 'a.mjs'), 'export default 3\n', 'utf8')
        assert.notEqual((await FK(rU, 'dist/umd')).evaluatorFpOf({}), fp0, '隨原始碼而變')
    })

    it('打包為 UMD 單檔後(真實建置:本套件之 gDistRollup 同一組選項;不動 ./dist):任務書所寫之程式夾仍為套件根下之 src/domain 與 src(改前為打包檔所在之夾);與 ESM 深層路徑載入者逐字相同', function () {
        let out = path.join(t.dir, 'distOut')
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'test', 'tools', 'distBuild.mjs'), FD_ROOT, out], { cwd: FD_ROOT, windowsHide: true, encoding: 'utf8', timeout: 170000 })
        if (r.status === 3) {
            this.skip() //w-package-tools(devDependency)不可得
        }
        let fpBundle = path.join(out, 'w-trade-adaptivess.umd.js')
        assert(fs.existsSync(fpBundle), `打包檔已產出: ${r.status} ${String(r.stdout).slice(-300)} ${String(r.stderr).slice(-300)}`)
        let W = createRequire(import.meta.url)(fpBundle)
        let st0 = getSettings()
        let st = { ...st0, rsi: { ...st0.rsi, guides: false } }
        let arm = { id: 'A04_act', layer: 'A', layerName: 'A 資格', title: '活躍度', desc: '近期有進場者', grid: null }
        let briefOf = (makeTexts) => makeTexts({ st, FD_ROOT: st.FD_ROOT }).nodeBrief({ workDir: path.join(st.records.workDir, 'nodeX'), task: { goal: 'g', type: 'explore', claim: null, arms: [arm], base: null, refs: [], direction: null, toolbox: null }, round: 7, nodeId: 'nodeX', attempt: 1 })
        let sDist = briefOf(W.makeTexts)
        let line = sDist.split('\n').find((l) => l.includes('讀取迴圈驗證之原始碼'))
        assert(line.includes('`src/domain/backtest*.mjs`') && line.includes('`src/domain/verify*.mjs`'), `「不得讀取」所列之程式夾: ${line}`)
        assert(/不得改 `src\/`、`g_\*\.mjs`/.test(sDist), '「不得改」所列之程式夾')
        assert(!/distOut|dist\/|umd/.test(sDist), '任務書不提打包檔所在之夾')
        //與 ESM 深層路徑載入者逐字相同(同一組設定)
        assert.equal(sDist, briefOf(makeTextsEsm), 'dist 與 ESM 之任務書逐字相同')
        //經打包檔呼叫 initProject: 套件根 = 套件夾(改前為其上一層 ⇒ 讀不到套件之 src/tools 而拋錯); --dry 列出之檔與 ESM 者逐項相同
        let rootA = path.join(t.dir, 'ipA')
        let rootB = path.join(t.dir, 'ipB')
        let a = W.initProject({ root: rootA, dry: true })
        let b = initProjectEsm({ root: rootB, dry: true })
        let norm = (x, root) => ({ written: x.written.map((f) => String(f).replace(root, '<root>')).sort(), kept: x.kept, skipped: x.skipped, differs: x.differs })
        assert.deepEqual(norm(a, rootA), norm(b, rootB), 'dist 與 ESM 之 initProject(--dry)結果相同')
        assert(a.written.length > 10, `列出將寫入之檔(含各工具之進入檔): ${a.written.length}`)
        assert(!fs.existsSync(rootA) && !fs.existsSync(rootB), '--dry 不寫')
    })
})
