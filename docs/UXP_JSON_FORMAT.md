# Sound Pad UXP JSON format

Sound PadからPremiere Pro UXPへ渡すJSONは、`format`と`schema_version`で種類を判別します。
現在のスキーマバージョンはどちらも`1`です。

## お気に入り

`format`は`sound-pad-favorites`です。画面上で選択したタグをすべて含むお気に入りだけを書き出します。

```json
{
  "format": "sound-pad-favorites",
  "schema_version": 1,
  "exported_at": "2026-08-01T00:00:00.000Z",
  "filters": {
    "tags": ["明るい", "OP/ED"],
    "match": "all"
  },
  "item_count": 1,
  "items": [
    {
      "file_path": "F:\\project\\material\\BGM\\sample.mp3",
      "file_name": "sample.mp3",
      "tags": ["明るい", "OP/ED"],
      "added_at": "1754000000"
    }
  ]
}
```

## セットリスト

`format`は`sound-pad-setlist`です。選択中セットリストの曲順を`order`で保持します。

```json
{
  "format": "sound-pad-setlist",
  "schema_version": 1,
  "exported_at": "2026-08-01T00:00:00.000Z",
  "setlist": {
    "id": "playlist-1754000000000",
    "name": "今回のセットリスト",
    "item_count": 1,
    "items": [
      {
        "order": 1,
        "file_path": "F:\\project\\material\\BGM\\sample.mp3",
        "file_name": "sample.mp3",
        "duration_seconds": 180.5,
        "added_at": "1754000000"
      }
    ]
  }
}
```

UXP側では未知のフィールドを無視し、未対応の`schema_version`を読み込む場合はエラーを表示してください。
