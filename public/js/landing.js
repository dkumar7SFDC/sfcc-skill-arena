import { $, api } from "./api.js";

try {
  await api("/api/auth/me");
  location.replace("/arena.html");
} catch {
  /* stay on landing */
}

const loginForm = $("#login-form");
const registerForm = $("#register-form");
const errorBox = $("#auth-error");

$("#tab-login").addEventListener("click", () => {
  $("#tab-login").classList.add("active");
  $("#tab-register").classList.remove("active");
  loginForm.classList.remove("hidden");
  registerForm.classList.add("hidden");
});
$("#tab-register").addEventListener("click", () => {
  $("#tab-register").classList.add("active");
  $("#tab-login").classList.remove("active");
  registerForm.classList.remove("hidden");
  loginForm.classList.add("hidden");
});

function showError(err) {
  errorBox.textContent = err.message;
  errorBox.classList.remove("hidden");
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.classList.add("hidden");
  const fd = new FormData(loginForm);
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: { email: fd.get("email"), password: fd.get("password") }
    });
    location.href = "/arena.html";
  } catch (err) {
    showError(err);
  }
});

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.classList.add("hidden");
  const fd = new FormData(registerForm);
  try {
    await api("/api/auth/register", {
      method: "POST",
      body: {
        name: fd.get("name"),
        email: fd.get("email"),
        password: fd.get("password")
      }
    });
    location.href = "/arena.html";
  } catch (err) {
    showError(err);
  }
});
