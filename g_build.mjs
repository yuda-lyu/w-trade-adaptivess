//進入檔(專案根): 把專案根告知套件(環境變數 ARSI_ROOT = 本檔所在之資料夾; 其子行程繼承)後, 載入對應之命令列程式
//  專案內之同名檔與此相同, 只把匯入路徑改為 'w-trade-adaptivess/src/cli/build.mjs'(以 node src/tools/initProject.mjs 產生)
import path from 'path'
import { fileURLToPath } from 'url'

process.env.ARSI_ROOT = path.dirname(fileURLToPath(import.meta.url))
await import('./src/cli/build.mjs')
