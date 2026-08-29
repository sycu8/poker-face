# Poker Faces — giới thiệu sản phẩm

**Bàn của bạn. Người của bạn.**

Poker Faces là ứng dụng Texas Hold'em **chip ảo** (play-money), mã nguồn mở — dành cho nhóm bạn chơi riêng, không phải sòng bài. Không nạp tiền, không rút tiền, không ví, không mua chip.

Live: [https://poker.orangecloud.vn](https://poker.orangecloud.vn)  
Repo: [github.com/sycu8/poker-face](https://github.com/sycu8/poker-face) · MIT License

---

## Chơi cùng bạn bè

1. Vào [poker.orangecloud.vn](https://poker.orangecloud.vn), đăng ký hoặc chơi khách (guest).
2. Host tạo bàn riêng, nhận **mã mời** (invite code).
3. Gửi mã cho bạn — họ xin vào bàn; host **duyệt** rồi mới ngồi được.
4. Host chia bài từng ván; chat text (và voice nếu bật) để nói chuyện như họp bàn thật.

Một link / một mã mời là đủ để cả nhóm vào cùng một bàn riêng.

---

## Fork và dựng platform riêng

Repo **public, MIT**. Ai thích có thể fork, tự host trên Cloudflare, chỉnh brand / luật bàn theo nhóm mình.

```bash
git clone https://github.com/sycu8/poker-face.git
cd poker-face
npm install
cp .env.example .dev.vars   # tối thiểu SESSION_SECRET
npm run db:migrate:local
npm run dev
```

Chi tiết đóng góp: [CONTRIBUTING.md](../CONTRIBUTING.md).  
Deploy staging/production: [GITHUB_ACTIONS_DEPLOY.md](./GITHUB_ACTIONS_DEPLOY.md).

---

## Tính năng cơ bản

| Tính năng | Mô tả ngắn |
| --- | --- |
| Texas Hold'em | Blinds, flop/turn/river, side pot, timer — server là nguồn đúng duy nhất |
| Chip ảo | Chỉ play-money; không mua bán, không cash-out |
| Bàn riêng | Host tạo bàn, mời bằng mã, duyệt / từ chối người vào |
| Guest join | Vào nhanh bằng tên hiển thị + mã mời, không bắt buộc tài khoản |
| Chat & voice | Chat text tại bàn; voice tùy chọn (RealtimeKit) |
| Host tools | Luật bàn, pause/resume, kick, chuyển host, đóng bàn, bot tập luyện |
| Lịch sử ván | Xem hand history / replay; sổ phiên + CSV |
| PWA | Cài như app trên điện thoại / desktop |
| Open source | Fork, sửa, deploy platform riêng |

---

## Không làm gì (cố ý)

- Không ngôn ngữ cược tiền thật, ví, nạp/rút, rake, giải thưởng tiền
- Không lộ bài riêng của người khác — privacy do server đảm bảo, không chỉ ẩn UI

---

## Chia sẻ nhanh (copy/paste)

> **Poker Faces** — Texas Hold'em chip ảo cho nhóm bạn. Bàn riêng, mời bằng mã, host duyệt vào. Chat + voice, PWA. Open source (MIT): fork rồi tự build platform của mình.  
> Chơi: https://poker.orangecloud.vn  
> Code: https://github.com/sycu8/poker-face
