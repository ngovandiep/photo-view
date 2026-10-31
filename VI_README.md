# Hướng dẫn MiLeo Photo Library

*Your memories. Your library. Your world.* MiLeo được đặt theo tên hai con trai Mike (Minh Khang) và Leo (Quang Đăng). Ứng dụng đồng bộ trên điện thoại là **MiLeo Sync**.

## Cài đặt trên Windows

Tải và chạy `MiLeo-Photo-Library-Setup-1.0.0-x64.exe` (các bản cũ có tên `Still-Photo-Library-Setup-…`). Bộ cài đặt dùng phạm vi tài khoản Windows hiện tại; có thể chọn thư mục cài đặt và tạo lối tắt Desktop hoặc Start Menu. Không cần cài Node.js để sử dụng ứng dụng.

Ứng dụng chưa được ký bằng chứng thư nhà phát hành. Windows SmartScreen có thể hiện cảnh báo khi mở bộ cài: chỉ tiếp tục nếu bộ cài đến từ nguồn bạn tin cậy. Việc ký mã và phân phối qua nhà phát hành đáng tin cậy sẽ giảm cảnh báo này.

## Lần đầu mở ứng dụng

1. Mở **MiLeo Photo Library** từ Start Menu hoặc lối tắt Desktop.
2. Chọn **Open folder** và chọn một hoặc nhiều thư mục ảnh, ví dụ `D:\Image` hoặc thư mục sự kiện nhỏ hơn.
3. Ứng dụng quét tên, đường dẫn, kích thước và thời gian sửa đổi của tệp để lập danh mục. Quá trình có hiển thị tiến độ; ảnh gốc chỉ được đọc khi tạo hình xem trước hoặc mở ảnh.
4. Chờ thông báo hoàn tất. Có thể chọn thư mục khác bằng danh sách ở thanh trên.

Các thư mục đã chọn được ghi nhớ trên máy tính. Khi mở ứng dụng lần sau, ứng dụng tự khôi phục danh sách và mở thư mục khả dụng gần nhất. Nếu ổ đĩa bị ngắt kết nối hoặc đường dẫn không còn truy cập được, ứng dụng báo trạng thái và giữ nguyên danh mục; kết nối lại ổ đĩa hoặc thêm lại thư mục. Ứng dụng không yêu cầu chọn lại thư mục ở mỗi lần mở nếu đường dẫn vẫn truy cập được.

## Duyệt và chỉnh sửa

Dùng tìm kiếm, bộ lọc thư mục/định dạng, sắp xếp và các mục Favorites, Tags, Albums để tổ chức danh mục. Thẻ, album, yêu thích và trạng thái tệp được lưu tự động trong dữ liệu ứng dụng Windows sau khi quét hoặc chỉnh sửa. Chức năng này chỉ cập nhật tệp JSON của ứng dụng, không đổi tên, di chuyển, xóa hay ghi metadata vào ảnh gốc.

Ứng dụng Windows giải mã HEIC/HEIF tại máy để tạo ảnh xem trước JPEG trong bộ nhớ; ảnh gốc không bị chuyển đổi hay chỉnh sửa và dữ liệu ảnh không được gửi đi nơi khác. Trong trình duyệt thông thường, xem trước HEIC/HEIF vẫn phụ thuộc vào khả năng hỗ trợ của trình duyệt. TIFF và RAW cũng phụ thuộc trình duyệt.

Ảnh thu nhỏ không thể xem trước sẽ hiển thị "No preview available", không dùng ảnh khác để thay thế.

## Thương hiệu

Quản trị viên có thể đổi tên ứng dụng, tên ngắn, khẩu hiệu, tên MiLeo Sync/MiLeo AI, địa chỉ website và logo (PNG, JPEG hoặc WebP, tối đa 512 KB) trong **Admin dashboard → Branding**. Chọn **Reset to defaults** để trở lại MiLeo. Dữ liệu cũ (thư mục `%APPDATA%\Still Photo Library`) vẫn được dùng nên thư viện, tài khoản và điện thoại đã ghép nối không bị mất khi nâng cấp.

## Sao lưu và khôi phục

- Chọn nút **Export JSON** để lưu một bản sao danh mục vào vị trí bạn chọn. JSON chứa đường dẫn tương đối, thông tin tệp, yêu thích, thẻ và album; không chứa byte ảnh.
- Giữ bản sao JSON ở một ổ đĩa khác nếu cần bảo vệ khi máy tính hỏng. Dữ liệu tự lưu trong thư mục userData của ứng dụng không thay thế bản sao lưu độc lập.
- Để khôi phục, mở đúng thư mục ảnh đã đăng ký, chọn **Import JSON**, chọn tệp sao lưu và xác nhận thay thế nếu ứng dụng hỏi. Danh mục hiện tại được sao lưu trước khi thay thế. Ứng dụng kiểm tra định dạng và tên thư mục gốc; sau khi quét, các mục được đối chiếu lại với tệp hiện có.
- Các bản sao an toàn trước khi nhập và dữ liệu cũ được giữ trong thư mục `photo-library/backups` bên trong thư mục userData của ứng dụng. Không xóa thư mục này nếu cần các bản sao đó.
- Khi gỡ ứng dụng, dữ liệu userData thường không bị xóa cùng chương trình. Giữ bản JSON xuất riêng trước khi cài lại Windows hoặc dọn dữ liệu ứng dụng.

## Tạo bộ cài từ mã nguồn

Cần Windows x64, Node.js và npm. Trong thư mục `photo-library`, chạy:

```powershell
npm install
npm start
npm run dist:win
```

Bộ cài NSIS được tạo trong thư mục `dist`. Quá trình tạo bộ cài cần tải Electron và các công cụ đóng gói khi chạy lần đầu. Thư mục ảnh không được đưa vào bộ cài. Hãy kiểm tra ứng dụng và bộ cài trên máy đích trước khi phân phối.
