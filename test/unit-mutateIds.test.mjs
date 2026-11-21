import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'
import { dupIdsOf } from './tools/mutateIds.mjs'

//變異工具(mutateBar.mjs、mutateStart.mjs)之 --check 另核全部變異之編號唯一(規則 R-PKG-9; Gitea #199 之另見 2 與主控之裁定)
//  規格: ①dupIdsOf 列出重複之編號(每個只列一次); 無重複回 [] ②兩工具之 --check 於編號重複時列出重複之編號並以非 0 離開(不受 --only 限制; 不跑錨點與測試); 無重複時印「編號唯一: N 項」
//    ③現行之兩份變異表編號皆唯一(以 --check 實跑核對; 見報告, 不在本測試內重跑全部錨點)
describe('變異工具之編號唯一(規則 R-PKG-9)', function () {
    this.timeout(120000)

    describe('① dupIdsOf(純函數)', function () {
        it('重複之編號各列一次(依第二次出現之序); 無重複、空表回 []', () => {
            assert.deepEqual(dupIdsOf([]), [])
            assert.deepEqual(dupIdsOf([['A01'], ['A02'], ['B01']]), [])
            assert.deepEqual(dupIdsOf([['A01'], ['A02'], ['A01']]), ['A01'])
            assert.deepEqual(dupIdsOf([['A01'], ['B01'], ['A02'], ['B01'], ['A01'], ['B01'], ['A01']]), ['B01', 'A01'], '三次出現者只列一次;依第二次出現之序')
            //編號區分大小寫與前後綴(A1 與 A01 為不同編號)
            assert.deepEqual(dupIdsOf([['A1'], ['A01'], ['a1']]), [])
        })
    })

    describe('② 兩工具之 --check(於複本之專案根實跑)', function () {
        let t
        before(() => {
            t = makeTmp('mutateIds')
        })
        after(() => {
            t.cleanup()
        })
        //複本之專案根: <t.dir>/<名>/test/tools/ 放該工具與共用之 mutateIds.mjs、synthLedger.mjs 之替身(只匯出複本之 FD_ROOT / FD_TMP; 真檔匯入評估器, 於複本內無 src)
        let mkRoot = (name, tool, inject) => {
            let root = path.join(t.dir, name)
            let tools = path.join(root, 'test', 'tools')
            fs.mkdirSync(tools, { recursive: true })
            for (let d of ['src', 'contract', 'arms', 'examples']) {
                fs.mkdirSync(path.join(root, d), { recursive: true })
            }
            for (let f of ['settings.json', 'package.json']) {
                fs.writeFileSync(path.join(root, f), '{}', 'utf8')
            }
            fs.writeFileSync(path.join(tools, 'synthLedger.mjs'), `export const FD_ROOT = ${JSON.stringify(root)}\nexport const FD_TMP = ${JSON.stringify(path.join(root, 'test', '_tmp'))}\n`, 'utf8')
            fs.copyFileSync(path.join(FD_ROOT, 'test', 'tools', 'mutateIds.mjs'), path.join(tools, 'mutateIds.mjs'))
            let text = fs.readFileSync(path.join(FD_ROOT, 'test', 'tools', tool), 'utf8')
            let ids = [...text.matchAll(/^ {4}\['([A-Za-z0-9_]+)',/gm)]
            assert(ids.length > 50, `${tool}: 變異表之列數(鑑別前提)`)
            let dupId = null
            if (inject) {
                //植入一個重複之編號: 把第二列之編號改成第一列之編號(其餘不動)
                dupId = ids[0][1]
                let second = ids[1]
                text = `${text.slice(0, second.index)}    ['${dupId}',${text.slice(second.index + second[0].length)}`
            }
            fs.writeFileSync(path.join(tools, tool), text, 'utf8')
            return { root, tools, ids: ids.map((x) => x[1]), dupId }
        }
        let run = (r, tool, args) => spawnSync(process.execPath, [path.join(r.tools, tool), ...args], { cwd: r.root, encoding: 'utf8', windowsHide: true, timeout: 90000, env: { ...process.env, ARSI_ROOT: '' } })

        for (let tool of ['mutateBar.mjs', 'mutateStart.mjs']) {
            it(`${tool} --check: 植入重複之編號 ⇒ 列出該編號、離開碼非 0(不跑錨點;--only 另指其他編號亦同); 無重複 ⇒ 印編號唯一之項數`, () => {
                let bad = mkRoot(`bad_${tool}`, tool, true)
                for (let args of [['--check'], ['--check', '--only', bad.ids[bad.ids.length - 1]]]) {
                    let r = run(bad, tool, args)
                    let out = `${r.stdout}\n${r.stderr}`
                    assert.notEqual(r.status, 0, `${args.join(' ')}: ${out.slice(0, 300)}`)
                    assert(r.stdout.includes('編號重複') && r.stdout.includes(bad.dupId), `${args.join(' ')}: ${out.slice(0, 300)}`)
                    assert(!r.stdout.includes('編號唯一'), r.stdout)
                    assert(!/anchor-ok|ANCHOR-ERROR/.test(r.stdout), `重複時不跑錨點之核對: ${r.stdout}`)
                }
                //只重複一個編號 ⇒ 只列該編號
                assert(run(bad, tool, ['--check']).stdout.match(/編號重複[^\n]*/)[0].endsWith(bad.dupId))
                //對照: 無重複者印「編號唯一: N 項」(複本無 src ⇒ 其後錨點核對於複本內失敗屬預期; 此處只核編號之判定)
                let ok = mkRoot(`ok_${tool}`, tool, false)
                let r = run(ok, tool, ['--check', '--only', ok.ids[0]])
                assert(r.stdout.includes(`編號唯一: ${ok.ids.length} 項`), r.stdout.slice(0, 300))
                assert(!r.stdout.includes('編號重複'), r.stdout)
            })
        }
    })
})
