# 行旅地圖工坊

把任意中文遊記文本整理成可人工審核的地名資料與互動路線。

## 直接使用

雙擊 `啟動網頁.cmd`。瀏覽器會開啟：

`http://127.0.0.1:8765/`

需要停止時，雙擊 `停止網頁.cmd`。

即使沒有 OpenAI API 金鑰，也能：

- 在《浙遊日記》《粵西遊記四》《黔遊日記一》三個獨立專案間切換；
- 使用本地規則初步提取常見地名；
- 人工新增、刪除或修改地名；
- 搜尋 OpenStreetMap 坐標；
- 在地圖上拖動標點修正坐標；
- 判定「經過／未經過／無法判斷」；
- 提交後隱藏未經過地點並重算路線；
- 匯出 Excel、JSON、GeoJSON、CSV 和獨立 HTML 地圖。

三篇文本的人工審核草稿分開保存在瀏覽器本機，不會因切換文本互相覆寫。地圖填色只表示府級、縣級與「其他經過地點」；待核、未經過與無法判斷改用外框、問號或叉號表示。

## 啟用完整文本 Agent

請不要把 API 金鑰貼入網頁或提交到文件。啟動前在 PowerShell 的當前視窗設定：

```powershell
$env:OPENAI_API_KEY = '你的金鑰'
.\啟動網頁.ps1
```

可選擇其他模型：

```powershell
$env:OPENAI_MODEL = 'gpt-5.6-terra'
```

完整 Agent 會讀取 `data/Prompt for 地名抽取及繪圖.docx` 作為主要工作規則，並使用 OpenAI Responses API 的嚴格 JSON Schema。輸出分開記錄 GIS 收錄判定、記錄層級、作者行程狀態、定位狀態、歷史行政隸屬、原文證據與坐標證據。

預設可在 Prompt 指定的識典古籍、CHGIS、OpenStreetMap、Wikidata、WHG Gazetteer 與百度來源範圍內搜尋。若不希望 Agent 使用網絡搜尋，可在啟動前設定：

```powershell
$env:OPENAI_WEB_SEARCH = '0'
```

金鑰只存在本機服務端環境中，不會傳到瀏覽器或匯出成果。無 API 金鑰時仍可使用本地初步抽取與完整人工審核介面。

## 發布成公開網站

本專案包含 Python API，不能直接以 GitHub Pages 運行完整功能。建議把程式碼放入 GitHub 倉庫，再由 Render 建立 Web Service。

1. 把整個專案提交至 GitHub。由於 `data/projects/` 包含三篇遊記原文與研究資料，若不希望公開下載內容，請使用私有倉庫。
2. 在 Render 選擇 **New → Blueprint**，連接該 GitHub 倉庫。Render 會讀取根目錄的 `render.yaml`。
3. 部署完成後，Render 會提供公開的 `https://<服務名稱>.onrender.com/` 網址。
4. 如需完整文本 Agent，在 Render 的 Environment 頁面新增 Secret：`OPENAI_API_KEY`。不要把金鑰寫入 GitHub。

若不用 Blueprint，也可以建立 Python Web Service 並填入：

```text
Build Command: pip install -r requirements.txt
Start Command: python app.py --host 0.0.0.0 --port $PORT
Health Check Path: /api/status
```

目前人工核定草稿儲存在訪客瀏覽器的 `localStorage`。公開網站上的每位訪客會有各自的草稿，資料不會彼此同步；多人協作需要另接帳號系統與資料庫。

## 路線規則

- 路線順序依原文地名提及次序。
- 只有最終判定為「經過」的記錄可以成為路線節點。
- 只有相鄰的兩筆經過記錄都具有坐標時才畫線；缺少坐標會造成路線中斷，不會跨節點連接。
- 兩點直線只表示記錄先後關係，不代表真實道路或水路。
- 相鄰節點直線距離超過 150 公里時標成紅色虛線，提示人工檢查。
- 「未經過」標點只在提交後隱藏；提交前仍顯示，便於人工比較。
- 坐標核定與是否經過是兩個獨立決定；CHGIS／OpenStreetMap 已核實坐標不會被地方志推定自動覆寫。
- 地方志相對方位推定採 1 古里 = 576 米，只作帶不確定性的候選位置。

## 主要文件

- `app.py`：本機網頁服務、Agent、DOCX 讀取、坐標搜尋與 Excel 匯出。
- `web/`：網頁介面與互動地圖。
- `data/sample_project.json`：由徐霞客審核工作簿產生的示例。
- `data/projects/`：三篇預載文本的統一 v3 專案資料與索引。
- `data/Prompt for 地名抽取及繪圖.docx`：Agent 的主要分析規則。
- `build_sample.py`：重新產生示例資料。
- `build_library.py`：從三份來源 DOCX 與既有研究資料重建多文本資料庫。
