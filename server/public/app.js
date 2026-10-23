// Smart Locker Client Application
const API_BASE = window.location.origin;

let currentShadow = null;
let currentPackages = [];
let isQuarantined = false;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  startPolling();
});

// Setup Tab Navigation
function setupTabs() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const tabId = btn.getAttribute('data-tab');
      const targetPane = document.getElementById(`tab-${tabId}`);
      if (targetPane) targetPane.classList.add('active');
    });
  });
}

// Poll server for live updates
function startPolling() {
  fetchShadow();
  fetchLogs();
  fetchAnomalies();

  setInterval(() => {
    fetchShadow();
  }, 1500);

  setInterval(() => {
    fetchLogs();
    fetchAnomalies();
  }, 3000);
}

// Fetch Device Shadow
async function fetchShadow() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/shadow`);
    if (!res.ok) throw new Error('Failed to fetch shadow');
    const data = await res.json();
    currentShadow = data;
    renderShadow(data);
  } catch (err) {
    document.getElementById('serverStatusDot').className = 'status-indicator';
    document.getElementById('serverStatusText').textContent = 'Mất kết nối máy chủ';
  }
}

// Render Device Shadow Data to UI
function renderShadow(data) {
  document.getElementById('serverStatusDot').className = 'status-indicator online';
  document.getElementById('serverStatusText').textContent = 'Đang kết nối: Port 5000';

  const reported = data.reported || {};
  const desired = data.desired || {};

  // JSON code displays (nếu có phần tử hiển thị)
  const jsonRep = document.getElementById('jsonReported');
  if (jsonRep) jsonRep.textContent = JSON.stringify(reported, null, 2);
  const jsonDes = document.getElementById('jsonDesired');
  if (jsonDes) jsonDes.textContent = JSON.stringify(desired, null, 2);

  // Lock State
  const lockText = document.getElementById('lockStateText');
  const visualDoor = document.getElementById('visualDoor');
  const visualLockLed = document.getElementById('visualLockLed');
  const isUnlocked = reported.lock_state === 'UNLOCKED';

  lockText.textContent = isUnlocked ? 'ĐÃ MỞ KHÓA' : 'ĐANG KHÓA';
  lockText.className = 'stat-value ' + (isUnlocked ? 'text-success' : '');
  if (visualLockLed) {
    visualLockLed.className = 'locker-led ' + (isUnlocked ? 'unlocked' : '');
  }

  // Door State (Reed Switch)
  const doorText = document.getElementById('doorStateText');
  const isDoorOpen = reported.door_state === 'OPEN';
  doorText.textContent = isDoorOpen ? 'CỬA ĐANG MỞ' : 'CỬA ĐÃ ĐÓNG';
  doorText.className = 'stat-value ' + (isDoorOpen ? 'text-warning' : '');

  if (visualDoor) {
    if (isDoorOpen) {
      visualDoor.classList.add('door-open');
    } else {
      visualDoor.classList.remove('door-open');
    }
  }

  // Locker & Parcel & OTP status
  const statusBadge = document.getElementById('lockerStatusBadge');
  const parcelBox = document.getElementById('visualParcel');
  const parcelLabel = document.getElementById('visualParcelId');
  const currentPkgSpan = document.getElementById('currentPackageId');
  const doorCounterText = document.getElementById('doorCounterText');

  if (reported.door_open_count !== undefined) {
    doorCounterText.textContent = `${reported.door_open_count} lần`;
  }

  const pkgId = reported.package_id || 'NONE';
  const isOtpValid = reported.otp_active !== false && pkgId !== 'NONE';

  currentPkgSpan.textContent = pkgId;
  if (parcelLabel) parcelLabel.textContent = pkgId;

  if (isOtpValid) {
    statusBadge.textContent = 'CÓ HÀNG (OTP KHẢ DỤNG)';
    statusBadge.className = 'badge badge-info';
    if (parcelBox) parcelBox.style.opacity = '1';
  } else if (pkgId === 'NONE' || reported.otp_active === false) {
    statusBadge.textContent = 'TRỐNG (OTP ĐÃ KHÓA)';
    statusBadge.className = 'badge badge-success';
    if (parcelBox) parcelBox.style.opacity = '0.2';
  }

  // Sync rate (Fixed 5s interval, no backoff)
  const syncRate = reported.sync_interval_ms || 5000;
  const syncRateText = document.getElementById('syncRateText');
  if (syncRateText) syncRateText.textContent = `${syncRate.toLocaleString()} ms`;

  // Quarantine / Isolation status
  isQuarantined = reported.quarantine_mode || desired.quarantine_mode || false;
  const qBanner = document.getElementById('quarantineBanner');
  const qBtnText = document.getElementById('quarantineBtnText');
  const qBtn = document.getElementById('btnEmergencyQuarantine');

  if (isQuarantined) {
    qBanner.classList.remove('hidden');
    qBtnText.textContent = 'ĐANG CÁCH LY';
    qBtn.className = 'btn btn-secondary';
    document.getElementById('visualOledMsg').textContent = 'QUARANTINE';
  } else {
    qBanner.classList.add('hidden');
    qBtnText.textContent = 'Cách ly Khẩn cấp';
    qBtn.className = 'btn btn-danger';
    document.getElementById('visualOledMsg').textContent = isUnlocked ? 'ĐÃ MỞ' : 'SẴN SÀNG';
  }

  // Subsystems / Circuit Breakers Switches
  const sub = reported.subsystems || {};
  updateBreakerUI('Qr', sub.qr_reader);
  updateBreakerUI('Keypad', sub.keypad);
  updateBreakerUI('Cloud', sub.cloud_sync);
  updateBreakerUI('Actuator', sub.lock_actuator);

  // Personal Locker 5-minute OTP render
  if (data.personalLocker || (data.activePackages && data.activePackages.length > 0)) {
    renderPersonalLocker(data.personalLocker || data.activePackages[0]);
  }
}

// Update Breaker UI helper
function updateBreakerUI(name, isEnabled) {
  const sw = document.getElementById(`switchBreaker${name}`);
  const st = document.getElementById(`statusBreaker${name}`);
  if (!sw || !st) return;

  const enabled = isEnabled !== false;
  sw.checked = enabled;
  if (enabled) {
    st.textContent = 'Hoạt động bình thường';
    st.className = 'breaker-status text-success';
  } else {
    st.textContent = 'ĐÃ CÔ LẬP (NGẮT NGUỒN)';
    st.className = 'breaker-status text-danger';
  }
}

// (Cơ chế lũy tuyến băng thông đã được xóa bỏ theo yêu cầu đồ án cá nhân)

// Fetch Audit Logs
async function fetchLogs() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/audit/logs`);
    if (!res.ok) return;
    const logs = await res.json();
    const tbody = document.getElementById('auditLogsBody');
    if (!tbody) return;

    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">Chưa có bản ghi kiểm toán</td></tr>';
      return;
    }

    tbody.innerHTML = logs.map(item => {
      let badgeClass = 'badge';
      if (item.level === 'CRITICAL' || item.level === 'ANOMALY') badgeClass = 'badge badge-danger';
      else if (item.level === 'SECURITY') badgeClass = 'badge badge-success';
      else if (item.level === 'CIRCUIT_BREAKER') badgeClass = 'badge badge-info';

      const timeStr = new Date(item.timestamp).toLocaleTimeString();
      return `
        <tr>
          <td><span style="font-family:var(--font-mono)">${timeStr}</span></td>
          <td><span class="${badgeClass}">${item.level}</span></td>
          <td><strong>${item.source}</strong></td>
          <td>${item.event}</td>
          <td>${escapeHtml(item.details)}</td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    console.error('Logs fetch error', e);
  }
}

// Fetch Anomalies Summary
async function fetchAnomalies() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/anomalies`);
    if (!res.ok) return;
    const anomalies = await res.json();

    let bruteCount = 0;
    let tamperCount = 0;
    let ajarCount = 0;
    let chipSwapCount = 0;

    anomalies.forEach(a => {
      const type = (a.type || '').toUpperCase();
      if (type.includes('BRUTE')) bruteCount++;
      else if (type.includes('TAMPER') || type.includes('BREAK_IN')) tamperCount++;
      else if (type.includes('AJAR') || type.includes('OPEN')) ajarCount++;
      else if (type.includes('CHIP') || type.includes('MAC')) chipSwapCount++;
    });

    document.getElementById('countBruteForce').textContent = bruteCount;
    document.getElementById('countTamper').textContent = tamperCount;
    document.getElementById('countDoorAjar').textContent = ajarCount;
    document.getElementById('countChipSwap').textContent = chipSwapCount;
  } catch (e) {
    console.error('Anomalies fetch error', e);
  }
}

// Remote Desired Lock State Update
async function setDesiredLock(state) {
  try {
    await fetch(`${API_BASE}/api/v1/shadow/desired`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lock_state: state, command: state === 'UNLOCKED' ? 'UNLOCK' : 'LOCK' })
    });
    fetchShadow();
  } catch (err) {
    alert('Lỗi gửi lệnh điều khiển từ xa!');
  }
}

function triggerRemoteUnlock() {
  setDesiredLock('UNLOCKED');
}

// Quarantine / Isolation Toggle
async function toggleQuarantine() {
  const nextAction = isQuarantined ? 'RESTORE_DEVICE' : 'QUARANTINE_DEVICE';
  try {
    await fetch(`${API_BASE}/api/v1/security/circuit-breaker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: nextAction })
    });
    fetchShadow();
  } catch (err) {
    alert('Lỗi thay đổi trạng thái cách ly!');
  }
}

function restoreFromQuarantine() {
  toggleQuarantine();
}

// Circuit Breaker Subsystem Toggle
async function toggleSubsystem(target, isEnabled) {
  try {
    await fetch(`${API_BASE}/api/v1/security/circuit-breaker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: isEnabled ? 'ENABLE' : 'DISABLE', target })
    });
    fetchShadow();
  } catch (err) {
    alert('Lỗi điều khiển circuit breaker!');
  }
}

// Render Personal Locker (1 User) - Dynamic 5-minute Rotating OTP
let countdownIntervalId = null;
let localOtpRemainingSec = 300;

function renderPersonalLocker(locker) {
  if (!locker) return;
  const otpValElem = document.getElementById('personalOtpValue');
  const statusBadge = document.getElementById('personalOtpStatusBadge');
  if (!otpValElem) return;

  const otp = locker.currentOtp || locker.otp || '123456';
  otpValElem.textContent = otp;

  const isActive = locker.status === 'ACTIVE' || locker.status === 'DELIVERING' || locker.status === 'IN_LOCKER';
  if (statusBadge) {
    statusBadge.textContent = isActive ? 'ĐANG HOẠT ĐỘNG' : 'ĐÃ HẾT HẠN';
    statusBadge.className = isActive ? 'badge badge-success' : 'badge badge-danger';
  }

  if (locker.remainingSec !== undefined) {
    localOtpRemainingSec = locker.remainingSec;
  }

  updateCountdownDisplay();

  if (!countdownIntervalId) {
    countdownIntervalId = setInterval(() => {
      if (localOtpRemainingSec > 0) {
        localOtpRemainingSec--;
        updateCountdownDisplay();
      }
    }, 1000);
  }
}

function updateCountdownDisplay() {
  const countElem = document.getElementById('personalOtpCountdown');
  const barElem = document.getElementById('otpCountdownBar');
  if (!countElem) return;

  const m = Math.floor(localOtpRemainingSec / 60);
  const s = localOtpRemainingSec % 60;
  countElem.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

  if (barElem) {
    const pct = Math.max(0, Math.min(100, (localOtpRemainingSec / 300) * 100));
    barElem.style.width = `${pct}%`;
    if (pct < 20) {
      barElem.style.background = '#ef4444';
    } else {
      barElem.style.background = 'linear-gradient(90deg, #10b981, #3b82f6)';
    }
  }
}

function copyPersonalOtp() {
  const otpElem = document.getElementById('personalOtpValue');
  const otp = otpElem ? otpElem.textContent.trim() : '';
  if (!otp) return;
  navigator.clipboard.writeText(otp);
  alert(`Đã sao chép mã OTP cá nhân: ${otp}\nBạn có thể nhập mã này trên Keypad 4x4 để mở tủ!`);
  grid.innerHTML = packages.map(pkg => `
    <div class="pkg-card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span class="pkg-code">${pkg.packageId}</span>
        <span class="badge ${pkg.status === 'DELIVERING' ? 'badge-info' : (pkg.status === 'IN_LOCKER' ? 'badge-warning' : 'badge-success')}">${pkg.status}</span>
      </div>
      <div style="margin-top:10px; font-size:0.85rem;">
        <div><strong>Người nhận:</strong> ${escapeHtml(pkg.resident)}</div>
        <div><strong>Điện thoại:</strong> ${escapeHtml(pkg.phone)}</div>
      </div>
      <div style="text-align:center; margin-top:8px;">
        <div style="font-size:0.75rem; color:var(--text-muted);">Mã OTP Mở Tủ:</div>
        <div class="pkg-otp-display">${pkg.otp}</div>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px; margin-top:10px;">
        <div style="display:flex; gap:6px;">
          <button class="btn btn-sm btn-outline" style="flex:1" onclick="copyOtp('${pkg.otp}')">Sao chép OTP</button>
          <button class="btn btn-sm btn-primary" style="flex:1" onclick="activateOtpToLocker('${pkg.packageId}', '${pkg.otp}')">Gửi OTP tới ESP (MQTT)</button>
        </div>
        <button class="btn btn-sm btn-secondary" style="width:100%" onclick="verifyOtpViaMqtt('${pkg.otp}')">Kiểm tra mã OTP (MQTT)</button>
      </div>
    </div>
  `).join('');
}

function copyOtp(otp) {
  navigator.clipboard.writeText(otp);
  alert(`Đã sao chép OTP: ${otp}. Hãy nhập mã này trên bàn phím Keypad của ESP32!`);
}

async function activateOtpToLocker(packageId, otp) {
  try {
    const res = await fetch(`${API_BASE}/api/v1/packages/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageId, otp })
    });
    const result = await res.json();
    fetchShadow();
    alert(`Đã gửi OTP [${otp}] của kiện [${packageId}] qua MQTT Broker tới ESP32 thành công!\nBây giờ bạn có thể nhập mã này trên bàn phím ESP32 để mở tủ.`);
  } catch (err) {
    alert('Lỗi kích hoạt OTP tới ESP32!');
  }
}

async function verifyOtpViaMqtt(otp) {
  try {
    const res = await fetch(`${API_BASE}/api/v1/packages/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otp })
    });
    const result = await res.json();
    if (result.valid) {
      alert(`✅ Mã OTP [${otp}] HỢP LỆ! (Kiện: ${result.package ? result.package.packageId : 'N/A'})`);
    } else {
      alert(`❌ Mã OTP [${otp}] KHÔNG HỢP LỆ hoặc đã hết hạn/bị xóa!`);
    }
  } catch (err) {
    alert('Lỗi kiểm tra mã OTP!');
  }
}

function sendQrCodeToLocker(otp) {
  setDesiredLock('UNLOCKED');
}

async function triggerGenerateRandomOtp() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/packages/generate-random`, { method: 'POST' });
    const result = await res.json();
    fetchShadow();
    alert(`Đã tạo mã OTP ngẫu nhiên thành công!\nKiện hàng: ${result.package.packageId}\nMÃ OTP MỚI: ${result.package.otp}`);
  } catch (err) {
    alert('Lỗi khi đổi mã OTP ngẫu nhiên!');
  }
}

async function triggerDeleteOtp() {
  if (!confirm('Bạn có chắc chắn muốn HỦY / VÔ HIỆU HÓA mã OTP hiện tại không?')) {
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/v1/packages/delete-otp`, { method: 'POST' });
    await res.json();
    fetchShadow();
    alert('Đã xóa và hủy bỏ mã OTP thành công!\nLệnh đã được gửi tới ESP32 qua MQTT Broker.');
  } catch (err) {
    alert('Lỗi khi xóa mã OTP!');
  }
}

// Package Modal
function showNewPackageModal() {
  document.getElementById('modalNewPackage').classList.remove('hidden');
}

function closeNewPackageModal() {
  document.getElementById('modalNewPackage').classList.add('hidden');
}

async function submitNewPackage() {
  const resident = document.getElementById('inputResident').value.trim();
  const phone = document.getElementById('inputPhone').value.trim();
  const otp = document.getElementById('inputOtp').value.trim();

  if (!resident) {
    alert('Vui lòng nhập tên cư dân / số phòng!');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/v1/packages/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resident, phone, otp: otp || undefined })
    });
    const result = await res.json();
    closeNewPackageModal();
    fetchShadow();
    alert(`✅ Đã tạo đơn hàng thành công!\nKiện hàng: ${result.package.packageId}\nMã OTP: ${result.package.otp}\n(Đã gửi thông điệp tới MQTT Broker để ESP32 kiểm tra)`);
  } catch (err) {
    alert('Lỗi tạo đơn hàng!');
  }
}

// Utility: escape HTML
function escapeHtml(str) {
  if (!str) return '';
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
