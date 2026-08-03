# Sound Pad for Premiere Pro

Sound Padが書き出すJSONをPremiere Pro上で表示し、現在の再生ヘッド位置へ音声素材を上書き配置するUXPパネルです。

## 必要環境

- Adobe Premiere Pro 25.6以降
- UXP Developer Tool 2.2以降
- Sound Padの`schema_version: 1` JSON

## 開発時の読み込み

1. Premiere Proの「設定 > プラグイン」でDeveloper Modeを有効にし、Premiere Proを再起動します。
2. UXP Developer Toolで`premiere-uxp`フォルダの`manifest.json`を追加します。
3. Premiere Proで対象プロジェクトとシーケンスを開きます。
4. UXP Developer ToolからプラグインをLoadします。
5. Premiere Proの「ウィンドウ > UXPプラグイン > Sound Pad」を開きます。

## 使い方

1. Sound Padからお気に入りまたはセットリストJSONを書き出します。
2. パネルの「JSONを開く」からJSONを選択します。
3. 配置先のオーディオトラックを選択します。
4. 各行の「試聴」を押すとSource Monitorで先頭から再生し、「停止」で止められます。
5. 各行の「配置」を押すと、現在の再生ヘッド位置へ上書き配置されます。

JSON読込時には、プロジェクトのビンを再帰的に走査し、各`file_path`とProjectItemのメディアパスを完全パスで照合します。プロジェクト内に存在しない素材はグレーアウトし、配置できません。素材をPremiere Proへ読み込んだ後、「再照合」を押すと配置可能になります。

タイムラインですでに使われている素材には使用回数が表示されます。素材名をクリックすると配置先トラックと開始位置が展開され、「移動」でその位置へ再生ヘッドを移動できます。

## 対応JSON

- `sound-pad-setlist` / `schema_version: 1`
- `sound-pad-favorites` / `schema_version: 1`

未知のフィールドは無視します。未対応の`format`または`schema_version`はエラーにします。

## 配置について

配置は`SequenceEditor.createOverwriteItemAction()`を使用します。後続クリップをリップル移動せず、素材の長さだけ選択トラック上を上書きします。JSONから素材をPremiere Proへ自動インポートする処理は行いません。
