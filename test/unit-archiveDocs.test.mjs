import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { archiveExperience, archiveFeedback } from '../src/domain/archiveDocs.mjs'
import { makeTmp } from './tools/synthLedger.mjs'

describe('archiveDocs:專案指引文件之自動整理', function () {
    let t
    before(() => {
        t = makeTmp('archiveDocs')
    })
    after(() => {
        t.cleanup()
    })

    it('經驗檔:未逾上限不動;逾上限自最舊之節起整節搬出(原文照搬、條號不變),主檔留各條之條號與標題,至少保留最後兩節', () => {
        //規則 R-REC-17: 只搬不刪; 無人值守時文件逐輪變長, 節點與做夢每輪都要讀
        let fp = path.join(t.dir, 'experience.md')
        let body = (n) => `${n}. **〔通用〕標題${n}**(2026-11-12;r00x): ${'內文'.repeat(120)}`
        let mk = () => ['# 經驗', '', '> 說明', '', '## 主代理(建置期)', '', body(1), body(2), '', '## 做夢 agent(r001)', '', body(3), body(4), '', '## 做夢 agent(r002)', '', body(5), '', '## 做夢 agent(r003)', '', body(6), ''].join('\n')
        fs.writeFileSync(fp, mk(), 'utf8')
        assert.strictEqual(archiveExperience({ fp, maxBytes: 1e6 }), null)
        let r = archiveExperience({ fp, maxBytes: 2000, keepBytes: 2500, keepSections: 2, date: new Date(2026, 10, 12) })
        assert.deepEqual([r.moved, r.from, r.to, r.file], [4, 1, 4, 'experience_20261112.md'])
        let main = fs.readFileSync(fp, 'utf8')
        let arc = fs.readFileSync(path.join(t.dir, 'experience_20261112.md'), 'utf8')
        assert(main.startsWith('# 經驗\n\n> 說明') && main.includes('## 已抽出之舊經驗') && main.includes('  - 3. 〔通用〕標題3') && main.includes('experience_20261112.md'))
        assert(!main.includes(body(1)) && main.includes(body(5)) && main.includes(body(6)), '主檔只留最後兩節之原文')
        assert(arc.includes(body(1)) && arc.includes(body(4)) && arc.includes('## 做夢 agent(r001)') && !arc.includes(body(5)), '搬出者原文照搬')
        assert(main.indexOf('## 已抽出之舊經驗') < main.indexOf('## 做夢 agent(r002)'))
        //再逾上限: 索引節續寫、不重複建; 同日之檔名加序號; 仍至少保留最後兩節
        fs.appendFileSync(fp, ['## 做夢 agent(r004)', '', body(7), ''].join('\n'))
        let r2 = archiveExperience({ fp, maxBytes: 2000, keepBytes: 2500, keepSections: 2, date: new Date(2026, 10, 12) })
        assert.deepEqual([r2.moved, r2.from, r2.to, r2.file], [1, 5, 5, 'experience_20261112_2.md'])
        let main2 = fs.readFileSync(fp, 'utf8')
        assert.equal(main2.split('## 已抽出之舊經驗').length - 1, 1)
        assert(main2.includes('  - 1. 〔通用〕標題1') && main2.includes('  - 5. 〔通用〕標題5') && main2.includes(body(6)) && main2.includes(body(7)) && !main2.includes(body(5)))
        assert.strictEqual(archiveExperience({ fp, maxBytes: 100, keepBytes: 100, keepSections: 2 }), null, '只剩應保留之節時不再搬')
    })

    it('回饋檔:逾上限時保留表頭與最後數列,其餘搬出(帶同一表頭);檔頭加註去處', () => {
        let fp = path.join(t.dir, 'feedback.md')
        let row = (i) => `| 2026-11-12 | 類別 | 對象${i} | ${'內容'.repeat(60)} | 依據 |`
        fs.writeFileSync(fp, ['# 回饋', '', '> 說明', '', '| 日期 | 類別 | 對象 | 內容 | 依據 |', '|---|---|---|---|---|', ...Array.from({ length: 10 }, (_, i) => row(i + 1)), ''].join('\n'), 'utf8')
        assert.strictEqual(archiveFeedback({ fp, maxBytes: 1e6 }), null)
        let r = archiveFeedback({ fp, maxBytes: 1000, keepRows: 3, date: new Date(2026, 10, 12) })
        assert.deepEqual([r.moved, r.file], [7, 'feedback_20261112.md'])
        let main = fs.readFileSync(fp, 'utf8')
        let arc = fs.readFileSync(path.join(t.dir, 'feedback_20261112.md'), 'utf8')
        assert(main.includes('feedback_20261112.md') && main.includes('| 日期 | 類別 | 對象 | 內容 | 依據 |') && main.includes(row(8)) && main.includes(row(10)) && !main.includes(row(7)))
        assert(arc.includes('| 日期 | 類別 | 對象 | 內容 | 依據 |') && arc.includes(row(1)) && arc.includes(row(7)) && !arc.includes(row(8)))
    })
})
