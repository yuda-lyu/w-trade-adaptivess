import assert from 'assert'
import fs from 'fs'
import path from 'path'
import * as PS from '../src/domain/pickStore.mjs'
import { extSurfaceOf } from '../src/domain/verify.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//共同儲存區之各列帶各擴充診斷自帶之 board / flag / notContent / subset(規則 R-REC-31;Gitea #169,使用端提案,純新增;R-REC-21、R-REC-22、R-REC-27 之延伸):
//  取自節點文件之 harness.raw.metrics.ext(迴圈重跑之正本與其後之補算), 原值不改寫、不截斷 ⇒ 讀節點文件與讀總表看得到同一份值;有無之判定同 extSurfaceOf
//  以命名空間匯入: 於未支援之版本(修前)各案分別失敗, 不因匯入具名之項不存在而整檔無法載入
describe('共同儲存區:各列之擴充診斷之看板值(規則 R-REC-31)', function () {
    let { buildPickStore, infoOf, FIELD_DEFS } = PS
    //各診斷之值皆不同(含型別), 使欄位錯位可被看出
    let EXT = {
        zeta: { board: 12.5, flag: '提示 z', text: '說明 z(不收)', ms: 7 },
        alpha: { board: '99.0 / 帶 13.1', subset: '時效 ≥ 15', notContent: '執行規則帶來大增益', other: 3 },
        beta: { board: 'a|b\nc', flag: '含直線|與換行\n之提示' },
        gamma: { board: '', flag: '   ', notContent: '', subset: '  ' },
        delta: { board: NaN, flag: 5, notContent: { x: 1 }, subset: ['s'] },
        eps: { error: '診斷拋錯:' + 'x'.repeat(200), board: 'e 不收' },
        theta: { board: 0, flag: null },
        iota: { board: 'b'.repeat(80) },
        kappa: [1, 2],
        lambda: null,
        mu: 42,
        //error 為空字串 = 無錯(同 extSurfaceOf: `o.error` 為假者照常取各欄); 函數 = 非物件而略過(JSON 往返後亦無此項)
        omicron: { error: '', board: 'ok-o' },
        fn: () => 1,
    }
    //EXT 之預期(獨立手寫: 依診斷名排序;未帶或空白者 null;board 收有限數字〔含 0〕;出錯者只有 error〔前 120 字〕;其他鍵不帶出;陣列、null、數字略過)
    let EXPECT = {
        alpha: { board: '99.0 / 帶 13.1', flag: null, notContent: '執行規則帶來大增益', subset: '時效 ≥ 15' },
        beta: { board: 'a|b\nc', flag: '含直線|與換行\n之提示', notContent: null, subset: null },
        delta: { board: null, flag: null, notContent: null, subset: null },
        eps: { error: `診斷拋錯:${'x'.repeat(115)}` },
        gamma: { board: null, flag: null, notContent: null, subset: null },
        iota: { board: 'b'.repeat(80), flag: null, notContent: null, subset: null },
        omicron: { board: 'ok-o', flag: null, notContent: null, subset: null },
        theta: { board: 0, flag: null, notContent: null, subset: null },
        zeta: { board: 12.5, flag: '提示 z', notContent: null, subset: null },
    }
    let doc = (id, S, ext) => ({
        nodeId: id,
        round: 3,
        attempt: 1,
        status: 'executed',
        spec: { arms: ['A01_nt'], base: null },
        task: { goal: 'g', type: 'explore' },
        conclusion: { outcome: 'improved', summary: '摘要' },
        harness: { ok: true, summary: [], notes: [], checks: { issues: [] }, score: { S, ladder: 3, flags: { vetoed: false, why: [] } }, raw: { replays: [], metrics: { selHash: `h${S}`, ...(ext === undefined ? {} : { ext }) } } },
    })

    it('extRowOf:每個物件型之診斷一列(依名稱排序);board / flag / notContent / subset 取原值(不改寫、不截斷);未帶或空白者 null;board 收有限數字(含 0);出錯者只有 error(前 120 字);其他鍵不帶出;非物件者略過', () => {
        let r = PS.extRowOf({ ext: EXT })
        assert.deepEqual(Object.keys(r), Object.keys(EXPECT), '依名稱排序、非物件之診斷(陣列、null、數字)略過')
        assert.deepEqual(r, EXPECT)
        assert.equal(r.iota.board, 'b'.repeat(80), '不截斷(看板之表格另行截 32 字)')
        assert.equal(r.beta.board, 'a|b\nc', '原值(看板之表格另行清理直線與換行)')
        assert.deepEqual(PS.extRowOf({}), {})
        assert.deepEqual(PS.extRowOf(null), {})
        assert.deepEqual(PS.extRowOf(undefined), {})
        assert.deepEqual(PS.extRowOf({ ext: [EXT.alpha] }), {}, 'ext 為陣列 ⇒ 空')
        assert.deepEqual(PS.extRowOf({ ext: 'x' }), {}, 'ext 非物件 ⇒ 空')
        assert.deepEqual(PS.extRowOf({ ext: {} }), {})
        //board 為字串之原值亦含前後空白者(只判定有無,不修剪);Infinity 與 -Infinity 為無值
        assert.deepEqual(PS.extRowOf({ ext: { a: { board: '  v ' }, b: { board: Infinity }, c: { board: -Infinity }, d: { board: -3.5 } } }), {
            a: { board: '  v ', flag: null, notContent: null, subset: null },
            b: { board: null, flag: null, notContent: null, subset: null },
            c: { board: null, flag: null, notContent: null, subset: null },
            d: { board: -3.5, flag: null, notContent: null, subset: null },
        })
    })

    it('與看板、迴圈檢查、搜尋地圖之取法(extSurfaceOf)一致:有看板值、提示、組成對照之自述、子集之診斷之集合相同,且清理後之值相同', () => {
        let r = PS.extRowOf({ ext: EXT })
        let s = extSurfaceOf({ ext: EXT })
        let names = (k) => Object.keys(r).filter((n) => r[n][k] !== null && r[n][k] !== undefined).sort()
        assert.deepEqual(names('board'), s.cells.map((x) => x.name).sort())
        assert.deepEqual(names('flag'), s.flags.map((x) => x.name).sort())
        assert.deepEqual(names('notContent'), s.notContent.map((x) => x.name).sort())
        assert.deepEqual(names('subset'), s.subsets.map((x) => x.name).sort())
        assert(s.cells.length >= 5 && s.flags.length >= 2 && s.notContent.length >= 1 && s.subsets.length >= 1, '鑑別前提: 四種集合皆非空')
        let clean = (v, n) => String(v).replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
        for (let c of s.cells) {
            assert.equal(clean(r[c.name].board, 32), c.value, c.name)
        }
        for (let f of s.flags) {
            assert.equal(clean(r[f.name].flag, 160), f.text, f.name)
        }
        for (let f of s.notContent) {
            assert.equal(clean(r[f.name].notContent, 160), f.text, f.name)
        }
        for (let f of s.subsets) {
            assert.equal(clean(r[f.name].subset, 32), f.label, f.name)
        }
        //出錯者: 看板略過、本列只有 error
        assert(!s.cells.some((x) => x.name === 'eps') && Object.keys(r.eps).join() === 'error')
    })

    it('infoOf / buildPickStore:各列之 ext 位於 backtest 之後、holdout 之前;index.json、info.json 與節點文件(JSON 往返後)同一份值;無 ext 之舊節點為 {};欄位定義與 README 列出 ext;總表之欄不變', async () => {
        let x = infoOf(doc('aaaaaaaaaaaaaaa1', 1, EXT))
        let keys = Object.keys(x)
        assert.equal(keys.indexOf('ext'), keys.indexOf('backtest') + 1)
        assert.equal(keys.indexOf('holdout'), keys.indexOf('ext') + 1)
        assert.deepEqual(x.ext, EXPECT)
        assert.deepEqual(infoOf(doc('aaaaaaaaaaaaaaa1', 1, undefined)).ext, {})
        //舊節點文件缺 harness.raw 時亦為 {}(不拋錯)
        assert.deepEqual(infoOf({ nodeId: 'bbbbbbbbbbbbbbb2', round: 1, spec: { arms: ['A01_nt'], base: null }, harness: { ok: true, score: { S: 1 } } }).ext, {})
        let t = makeTmp('pickStoreExt')
        try {
            let d = path.join(t.dir, 'proj')
            let st = { FD_ROOT: d, rsi: { root: path.join(d, 'rsi') }, records: { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), workDir: path.join(d, 'rsi/work') } }
            for (let k of Object.keys(st.records)) {
                fs.mkdirSync(st.records[k], { recursive: true })
            }
            //三個節點之 ext 互不相同(完整 / 單一診斷 / 無)
            let exts = [EXT, { solo: { board: 'v2', subset: '子集 2' } }, undefined]
            let want = [EXPECT, { solo: { board: 'v2', flag: null, notContent: null, subset: '子集 2' } }, {}]
            let ids = ['aaaaaaaaaaaaaaa1', 'bbbbbbbbbbbbbbb2', 'ccccccccccccccc3']
            ids.forEach((id, k) => {
                fs.mkdirSync(path.join(st.records.workDir, id), { recursive: true })
                fs.writeFileSync(path.join(st.records.workDir, id, 'pick.mjs'), `export const meta = { arms: ['A01_nt'], desc: '成品 ${k}' }\nexport default function pick(ctx) {\n    return []\n}\n`, 'utf8')
                fs.writeFileSync(path.join(st.records.nodeDir, `${id}.json`), JSON.stringify(doc(id, 10 + k, exts[k])), 'utf8')
            })
            await buildPickStore(st)
            let dir = path.join(st.rsi.root, 'picks')
            let idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
            let by = Object.fromEntries(idx.items.map((it) => [it.id, it.ext]))
            ids.forEach((id, k) => {
                assert.deepEqual(by[id], want[k], id)
                //節點文件(JSON 往返後)之 ext 與總表之同一份: 總表有值之各鍵(診斷名、鍵逐一核對)皆等於節點文件之原值(出錯者取前 120 字)
                let fromDoc = JSON.parse(fs.readFileSync(path.join(st.records.nodeDir, `${id}.json`), 'utf8')).harness.raw.metrics.ext || {}
                for (let nm of Object.keys(by[id])) {
                    assert(nm in fromDoc, `${id} ${nm} 為節點文件之診斷`)
                    for (let key of Object.keys(by[id][nm])) {
                        if (by[id][nm][key] !== null) {
                            assert.deepEqual(by[id][nm][key], key === 'error' ? String(fromDoc[nm].error).slice(0, 120) : fromDoc[nm][key], `${id} ${nm}.${key}`)
                        }
                    }
                }
                assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, id, 'info.json'), 'utf8')).ext, by[id], `${id} info.json`)
            })
            let defKey = 'ext.<診斷名>.board / flag / notContent / subset'
            let ks = FIELD_DEFS.map(([k]) => k)
            assert(ks.includes(defKey))
            assert.equal(ks.indexOf(defKey), ks.indexOf('backtest.selHash / pickSec / ledgerKey') + 1, '欄位定義之位置: 於 backtest 之末列之後')
            assert.deepEqual(idx.fields.map((f) => f.key), ks)
            let readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8')
            assert(readme.includes(`| \`${defKey}\` |`))
            //總表(INDEX.md)之欄不變
            let md = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8')
            assert(!md.includes('ext.') && md.split('\n').find((l) => l.startsWith('| 節點')) === '| 節點 | 輪 | 類型 | 臂(←起點) | 審計 | 回測期 S / 階梯 | 七相位 平均 / 最差 / 為正 | 挑選內容 內建 / 近 90 日(p) | 月均單 / 做多比例 | 保留期 績效 / 內容 | 機制(成品自述或結論摘要) |')
        }
        finally {
            t.cleanup()
        }
    })
})
