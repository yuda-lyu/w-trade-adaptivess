import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//評估器之指紋(附算與補算之快取之鍵; 規則 R-REC-34)不含只用於建帳本之 src/eval/ledgerBuild.mjs(規則 R-EV-44; Gitea #184 之裁定)與只由它於給了 unit 時動態匯入之 src/eval/unitNotional.mjs(排程第 547 項③; R-EV-52)
//  依據: 評估器(src/cli/eval.mjs 與其匯入之 src/eval/ 各檔)不匯入 ledgerBuild.mjs、unitNotional.mjs ⇒ 只改建帳本之升版不使附算與補算之值過時;
//  帳本之內容改變者經帳本之鍵(meta.key 含帳本格式版本)併入指紋
let SRC = path.join(FD_ROOT, 'src')

//靜態匯入與動態匯入之相對路徑(import … from './x.mjs'、import './x.mjs'、import('./x.mjs'))
let relImports = (fp) => {
    let text = fs.readFileSync(fp, 'utf8')
    let out = []
    for (let re of [/^\s*(?:import|export)\s[^'"`]*?from\s+['"](\.[^'"]+)['"]/gm, /^\s*import\s+['"](\.[^'"]+)['"]/gm, /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g]) {
        for (let m of text.matchAll(re)) {
            out.push(path.resolve(path.dirname(fp), m[1]))
        }
    }
    return out
}
let reachFrom = (entry) => {
    let seen = new Set()
    let todo = [path.resolve(entry)]
    while (todo.length) {
        let f = todo.pop()
        if (seen.has(f) || !/\.mjs$/.test(f) || !fs.existsSync(f)) {
            continue
        }
        seen.add(f)
        todo.push(...relImports(f))
    }
    return seen
}

describe('評估器之指紋不含建帳本之檔(規則 R-REC-34、R-EV-44)', function () {
    this.timeout(120000)
    let t
    before(() => {
        t = makeTmp('evalFp')
    })
    after(() => {
        t.cleanup()
    })

    it('前提: 評估器(src/cli/eval.mjs)之匯入鏈(靜態與動態)不含 src/eval/ledgerBuild.mjs;建帳本之入口(src/cli/build.mjs、主入口)才匯入它', () => {
        let reached = reachFrom(path.join(SRC, 'cli', 'eval.mjs'))
        assert(reached.has(path.join(SRC, 'eval', 'evalCore.mjs')) && reached.has(path.join(SRC, 'eval', 'ledger.mjs')) && reached.has(path.join(SRC, 'eval', 'barGrid.mjs')), `匯入鏈解析有效(鑑別前提): ${[...reached].length} 檔`)
        assert(!reached.has(path.join(SRC, 'eval', 'ledgerBuild.mjs')), '評估器不匯入 ledgerBuild.mjs')
        assert(reachFrom(path.join(SRC, 'cli', 'build.mjs')).has(path.join(SRC, 'eval', 'ledgerBuild.mjs')), '建帳本之入口匯入它(解析器抓得到此類匯入)')
        //unitNotional.mjs(只由 ledgerBuild.mjs 於給了 unit 時動態匯入; 排程第 547 項③)同屬建帳本專用: 評估器之匯入鏈不含、建帳本之入口經 ledgerBuild.mjs 之動態匯入可達
        assert(!reached.has(path.join(SRC, 'eval', 'unitNotional.mjs')), '評估器不匯入 unitNotional.mjs')
        assert(reachFrom(path.join(SRC, 'cli', 'build.mjs')).has(path.join(SRC, 'eval', 'unitNotional.mjs')), '建帳本之入口經 ledgerBuild.mjs 之動態匯入可達 unitNotional.mjs(解析器抓得到動態匯入)')
        assert(reachFrom(path.join(SRC, 'eval', 'ledgerBuild.mjs')).has(path.join(SRC, 'eval', 'unitNotional.mjs')), 'unitNotional.mjs 只經 ledgerBuild.mjs 匯入')
        //src/eval/ 內不在評估器之匯入鏈上之檔 = EVAL_FP_SKIP 之全部(新增而不在鏈上之檔須列入表或接入鏈; 列入表者須確不在鏈上 —— 否則指紋漏算評估器之原始碼)
        let evalDir0 = path.join(SRC, 'eval')
        let notInChain = fs.readdirSync(evalDir0).filter((f) => /\.mjs$/i.test(f) && !reached.has(path.join(evalDir0, f))).sort()
        let skipSrc = /let EVAL_FP_SKIP = \[([^\]]*)\]/.exec(fs.readFileSync(path.join(SRC, 'domain', 'fillKeys.mjs'), 'utf8'))
        assert(skipSrc, 'fillKeys.mjs 有 EVAL_FP_SKIP')
        assert.deepEqual([...skipSrc[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(), notInChain, '不在評估器之匯入鏈上之 src/eval/ 之檔 = EVAL_FP_SKIP')
        assert.deepEqual(notInChain, ['ledgerBuild.mjs', 'unitNotional.mjs'])
        //指紋之範圍須涵蓋評估器匯入鏈上之 src/eval/ 各檔(排除者只限不在匯入鏈上者)
        let evalDir = path.join(SRC, 'eval')
        let inChain = [...reached].filter((f) => path.dirname(f) === evalDir).map((f) => path.basename(f))
        assert(inChain.length >= 7, inChain.join(', '))
    })

    it('指紋:只改 ledgerBuild.mjs、unitNotional.mjs(建帳本專用)⇒ 不變;改 evalCore.mjs、barGrid.mjs(評估器匯入之檔)、cli/eval.mjs 任一 ⇒ 改變;新增 src/eval/ 之檔 ⇒ 改變', async () => {
        let root = path.join(t.dir, 'fk')
        for (let dd of ['src/domain', 'src/eval', 'src/cli']) {
            fs.mkdirSync(path.join(root, dd), { recursive: true })
        }
        //(排程第 477 項 ②: SRC 由往上找本套件之 package.json 定位 ⇒ 複本之配置須帶 package.json 並複製 pkgRoot.mjs, 否則往上找到本庫之套件根)
        for (let f of ['fillKeys.mjs', 'fillPlan.mjs', 'evalVersion.mjs', 'pkgRoot.mjs']) {
            fs.copyFileSync(path.join(SRC, 'domain', f), path.join(root, 'src', 'domain', f))
        }
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'w-trade-adaptivess' }), 'utf8')
        let w = (rel, s) => fs.writeFileSync(path.join(root, 'src', rel), s, 'utf8')
        //複本之 src/eval/ 之檔名 = 真實之 src/eval/ 全部之檔(內容為各自之檔名): 逐檔核對「改任一檔 ⇒ 指紋改變、只有 ledgerBuild.mjs 不變」
        let realEval = fs.readdirSync(path.join(SRC, 'eval')).filter((f) => /\.mjs$/.test(f))
        assert(realEval.includes('ledgerBuild.mjs') && realEval.includes('unitNotional.mjs') && realEval.includes('evalCore.mjs') && realEval.length >= 9, realEval.join(', '))
        for (let f of realEval) {
            w(`eval/${f}`, `export default '${f}'\n`)
        }
        w('cli/eval.mjs', 'export default 1\n')
        let FK = await import(pathToFileURL(path.join(root, 'src', 'domain', 'fillKeys.mjs')).href)
        let st = {}
        let fp0 = FK.evaluatorFpOf(st)
        assert(/^ev-[0-9a-f]{20}$/.test(fp0))
        //建帳本專用之檔(ledgerBuild.mjs; 排程第 547 項③ 另加 unitNotional.mjs)之內容(含註解)與有無皆不影響指紋
        for (let nm of ['ledgerBuild.mjs', 'unitNotional.mjs']) {
            w(`eval/${nm}`, 'export default "changed"\n//新增之註解\n')
            assert.equal(FK.evaluatorFpOf(st), fp0, `改 ${nm} ⇒ 不變`)
            fs.rmSync(path.join(root, 'src', 'eval', nm))
            assert.equal(FK.evaluatorFpOf(st), fp0, `無 ${nm} ⇒ 不變`)
            w(`eval/${nm}`, 'export default "back"\n')
        }
        //評估器之檔任一改變(src/eval/ 之每一個檔,除建帳本專用者;與 cli/eval.mjs)⇒ 指紋改變
        for (let [rel, restore] of [...realEval.filter((f) => !['ledgerBuild.mjs', 'unitNotional.mjs'].includes(f)).map((f) => [`eval/${f}`, `export default '${f}'\n`]), ['cli/eval.mjs', 'export default 1\n']]) {
            w(rel, `${restore}//改\n`)
            assert.notEqual(FK.evaluatorFpOf(st), fp0, `${rel} 改變 ⇒ 指紋改變`)
            w(rel, restore)
            assert.equal(FK.evaluatorFpOf(st), fp0, `${rel} 還原 ⇒ 指紋還原`)
        }
        //src/eval/ 新增之檔(評估器可能匯入)⇒ 指紋改變
        w('eval/newPart.mjs', 'export default 3\n')
        assert.notEqual(FK.evaluatorFpOf(st), fp0, '新增 src/eval/ 之檔 ⇒ 指紋改變')
    })
})
