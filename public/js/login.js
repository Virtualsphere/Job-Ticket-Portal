const loginForm = document.getElementById('loginForm');
const errorMsg = document.getElementById('errorMsg');

// Already logged in? go straight to dashboard.
if (getToken()) {
  window.location.href = '/dashboard.html';
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.style.display = 'block';
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMsg.style.display = 'none';
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  try {
    const data = await api('/auth/login', { method: 'POST', body: { email, password } });
    setSession(data.token, data.user);
    window.location.href = '/dashboard.html';
  } catch (err) {
    showError(err.message);
  }
});
