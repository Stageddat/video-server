const form = document.getElementById("uploadForm");
const passwordInput = document.getElementById("password");
const progressBar = document.getElementById("progress-bar");
const progressContainer = document.getElementById("progress-container");
const customNameInput = document.getElementById("customName");
const notification = document.getElementById("notification");
const status = document.getElementById("status");
const submitBtn = document.getElementById("submitBtn");
const videoFileInput = document.getElementById("videoFile");
const videoListContainer = document.getElementById("videoList"); // Get the video list container

let sseEventSource = null;

// --- Modal Elements (New) ---
const modal = document.createElement("div");
modal.id = "customModal";
modal.className = "modal-overlay";
modal.innerHTML = `
  <div class="modal-content">
    <p id="modalMessage"></p>
    <input type="text" id="modalInput" placeholder="Enter new name" style="display: none;">
    <div class="modal-actions">
      <button id="modalConfirmBtn" class="modal-confirm-btn">Confirm</button>
      <button id="modalCancelBtn" class="modal-cancel-btn">Cancel</button>
    </div>
  </div>
`;
document.body.appendChild(modal);

const modalMessage = document.getElementById("modalMessage");
const modalInput = document.getElementById("modalInput");
const modalConfirmBtn = document.getElementById("modalConfirmBtn");
const modalCancelBtn = document.getElementById("modalCancelBtn");

// --- Helper Functions ---
function handleAuthError(errorType, message) {
  passwordInput.classList.remove("input-error");
  passwordInput.classList.add("input-error");
  showNotification(message, true, "auth");
  passwordInput.value = "";
  setTimeout(() => passwordInput.focus(), 100);
  setTimeout(() => passwordInput.classList.remove("input-error"), 3000);
}

function resetFormState() {
  submitBtn.disabled = false;
  submitBtn.innerHTML = "<span>📤 Upload Video</span>";
  progressBar.style.width = "0%";
  progressBar.style.background = "linear-gradient(90deg, #667eea, #764ba2)";
  progressContainer.style.display = "none";
  hideStatus();
  form.reset();
  customNameInput.value = ""; // Clear custom name input
  if (sseEventSource) {
    sseEventSource.close();
    sseEventSource = null;
  }
}

function showStatus(message, type) {
  status.textContent = message;
  status.className = `status-${type}`;
  status.style.display = "block";
}

function hideStatus() {
  status.style.display = "none";
}

function showNotification(msg, isError = false, errorType = null) {
  notification.textContent = msg;
  notification.className = "";
  if (isError) {
    notification.className =
      errorType === "auth" ? "notification-auth-error" : "notification-error";
  } else {
    notification.className = "notification-success";
  }
  notification.style.display = "block";
  setTimeout(() => {
    notification.style.display = "none";
    notification.className = "";
  }, 5000);
}

// --- Modal Functions ---
function showModal(message, showInputField = false, defaultValue = "") {
  modalMessage.textContent = message;
  if (showInputField) {
    modalInput.style.display = "block";
    modalInput.value = defaultValue;
    modalInput.focus();
  } else {
    modalInput.style.display = "none";
  }
  modal.style.display = "flex";
  return new Promise((resolve) => {
    modalConfirmBtn.onclick = () => {
      modal.style.display = "none";
      resolve(showInputField ? modalInput.value : true);
    };
    modalCancelBtn.onclick = () => {
      modal.style.display = "none";
      resolve(false);
    };
  });
}

// --- Event Listeners ---
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = videoFileInput.files[0];
  if (!file) {
    showNotification("⚠️ Please select a video file.", true);
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = "<span>⏳ Preparing...</span>";
  progressContainer.style.display = "block";
  progressBar.style.width = "0%";
  progressBar.style.background = "linear-gradient(90deg, #667eea, #764ba2)";
  showStatus("Starting upload...", "processing");
  if (sseEventSource) sseEventSource.close(); // Close any existing SSE connection

  const formData = new FormData();
  formData.append("video", file);

  // Get custom name and append it to formData
  const customName = customNameInput.value.trim();
  if (customName) {
    formData.append("customName", customName);
  }

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/upload", true);
  xhr.setRequestHeader("Authorization", passwordInput.value);

  xhr.upload.onprogress = function (event) {
    if (event.lengthComputable) {
      const percent = (event.loaded / event.total) * 100;
      progressBar.style.width = percent + "%";
      showStatus(`Uploading file... ${Math.round(percent)}%`, "processing");
    }
  };

  xhr.onload = async function () {
    try {
      const response = JSON.parse(xhr.responseText);

      if (xhr.status === 401) {
        if (response.error === "MISSING_PASSWORD")
          handleAuthError("MISSING_PASSWORD", "🔒 Please enter a password");
        else if (response.error === "WRONG_PASSWORD")
          handleAuthError("WRONG_PASSWORD", "❌ Wrong password");
        else handleAuthError("AUTH_ERROR", "🚫 Authentication error");
        showStatus("❌ Authentication failed", "error");
        progressBar.style.background = "#ef4444";
        resetFormState();
        passwordInput.value = xhr.status === 401 ? "" : passwordInput.value;
        submitBtn.disabled = false;
        submitBtn.innerHTML = "<span>📤 Upload Video</span>";
        return;
      }

      if (xhr.status >= 400) {
        showStatus(`Error: ${response.message || "Upload failed"}`, "error");
        showNotification(`❌ ${response.message || "Upload failed"}`, true);
        progressBar.style.background = "#ef4444";
        resetFormState();
        return;
      }

      if (response.success && response.taskId) {
        // If the file was moved directly (special password), just show success and reset
        if (response.message === "Upload received, file moved directly.") {
          showStatus("Upload complete. File moved directly.", "success");
          showNotification(`✅ ${response.message}`);
          progressBar.style.width = "100%";
          progressBar.style.background = "#22c55e";
          await loadVideos(); // Reload videos to show the new one
          setTimeout(() => resetFormState(), 2000);
          return;
        }

        // For normal processing, initialize SSE
        showStatus("Upload complete. Initializing processing...", "processing");
        progressBar.style.width = "100%";

        sseEventSource = new EventSource(
          `/processing-status/${response.taskId}`
        );

        sseEventSource.onmessage = function (event) {
          const progressData = JSON.parse(event.data);

          if (progressData.stage === "probing") {
            showStatus(
              progressData.message || "Analyzing video...",
              "processing"
            );
            progressBar.style.width = "0%";
          } else if (progressData.stage === "probed_success") {
            showStatus(
              progressData.message ||
                "Analysis complete. Starting conversion...",
              "processing"
            );
            progressBar.style.width = "0%";
          } else if (progressData.stage === "processing") {
            progressBar.style.width = (progressData.percent || 0) + "%";
            showStatus(
              progressData.message ||
                `Processing... ${progressData.percent || 0}%`,
              "processing"
            );
          } else if (progressData.stage === "done") {
            showStatus(
              progressData.message || "Video processed successfully!",
              "success"
            );
            showNotification(
              `✅ ${progressData.message || "Video processed successfully!"}`
            );
            progressBar.style.width = "100%";
            progressBar.style.background = "#22c55e";
            sseEventSource.close();
            loadVideos(); // Reload videos to show the new one
            setTimeout(() => resetFormState(), 2000);
          } else if (progressData.stage === "error") {
            showStatus(
              `Error: ${progressData.error || "Processing failed"}`,
              "error"
            );
            showNotification(
              `❌ ${
                progressData.error || "An error occurred during processing."
              }`,
              true
            );
            progressBar.style.background = "#ef4444";
            sseEventSource.close();
            resetFormState();
          }
        };

        sseEventSource.onerror = function () {
          showStatus("Error connecting to processing status updates.", "error");
          showNotification(
            "🔌 Connection error with server for status updates.",
            true
          );
          progressBar.style.background = "#ef4444";
          sseEventSource.close();
          resetFormState();
        };
      } else {
        showStatus("Error: Could not initialize video processing.", "error");
        showNotification(
          `❌ ${response.message || "Failed to start processing."}`,
          true
        );
        progressBar.style.background = "#ef4444";
        resetFormState();
      }
    } catch (parseError) {
      console.error(
        "Parse error:",
        parseError,
        "Response text:",
        xhr.responseText
      );
      showStatus("Error processing server response", "error");
      showNotification("❌ Error processing server response", true);
      progressBar.style.background = "#ef4444";
      resetFormState();
    }
  };

  xhr.onerror = function () {
    showStatus("❌ Connection error during upload", "error");
    showNotification("🔌 Connection error with server", true);
    progressBar.style.background = "#ef4444";
    resetFormState();
  };

  xhr.send(formData);
});

// --- Video Management Functions ---
async function deleteVideo(filename) {
  const confirmed = await showModal(
    `Are you sure you want to delete '${filename}'? This action cannot be undone.`
  );
  if (!confirmed) {
    return;
  }

  showStatus(`Deleting '${filename}'...`, "processing");
  try {
    const res = await fetch(`/video/${encodeURIComponent(filename)}`, {
      method: "DELETE",
      headers: {
        Authorization: passwordInput.value,
      },
    });

    if (res.status === 401) {
      handleAuthError("WRONG_PASSWORD", "❌ Wrong password for deletion");
      showStatus("❌ Deletion failed: Authentication error", "error");
      return;
    }

    const response = await res.json();
    if (response.success) {
      showNotification(`✅ ${response.message}`);
      showStatus(`'${filename}' deleted.`, "success");
      loadVideos(); // Reload the list
    } else {
      showNotification(`❌ Error deleting video: ${response.message}`, true);
      showStatus(`❌ Deletion failed: ${response.message}`, "error");
    }
  } catch (error) {
    console.error("Error deleting video:", error);
    showNotification("❌ Network error during deletion.", true);
    showStatus("❌ Deletion failed: Network error", "error");
  } finally {
    setTimeout(() => hideStatus(), 2000);
  }
}

async function renameVideo(originalFilename) {
  const newName = await showModal(
    `Enter new name for '${originalFilename}':`,
    true,
    originalFilename.split(".").slice(0, -1).join(".")
  );
  if (
    !newName ||
    newName.trim() === "" ||
    newName.trim() === originalFilename.split(".").slice(0, -1).join(".")
  ) {
    showNotification(
      "⚠️ Rename cancelled or new name is invalid/same as original.",
      true
    );
    return;
  }

  showStatus(`Renaming '${originalFilename}' to '${newName}'...`, "processing");
  try {
    const res = await fetch("/rename", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: passwordInput.value,
      },
      body: JSON.stringify({ originalFilename, newName }),
    });

    if (res.status === 401) {
      handleAuthError("WRONG_PASSWORD", "❌ Wrong password for renaming");
      showStatus("❌ Rename failed: Authentication error", "error");
      return;
    }

    const response = await res.json();
    if (response.success) {
      showNotification(`📝 ${response.message}`);
      showStatus(
        `'${originalFilename}' renamed to '${response.newFilename}'.`,
        "success"
      );
      loadVideos(); // Reload the list
    } else {
      showNotification(`❌ Error renaming video: ${response.message}`, true);
      showStatus(`❌ Rename failed: ${response.message}`, "error");
    }
  } catch (error) {
    console.error("Error renaming video:", error);
    showNotification("❌ Network error during renaming.", true);
    showStatus("❌ Rename failed: Network error", "error");
  } finally {
    setTimeout(() => hideStatus(), 2000);
  }
}

async function loadVideos() {
  try {
    const res = await fetch("/videos");
    if (!res.ok) {
      throw new Error(`Failed to load videos: ${res.statusText}`);
    }
    const videos = await res.json();
    const container = document.getElementById("videoList");

    if (videos.length === 0) {
      container.innerHTML =
        '<div class="no-videos">📂 No videos uploaded yet</div>';
      return;
    }

    container.innerHTML = "";

    videos.forEach((video) => {
      const videoItem = document.createElement("div");
      videoItem.className = "video-item";

      const thumbnailDiv = document.createElement("div");
      thumbnailDiv.className = "video-thumbnail";

      // Create play overlay
      const playOverlay = document.createElement("div");
      playOverlay.className = "play-overlay";
      playOverlay.innerHTML = "▶️";

      if (video.thumbnail) {
        // Show thumbnail image
        const thumbnailImg = document.createElement("img");
        thumbnailImg.src = `/thumbnail/${encodeURIComponent(video.thumbnail)}`;
        thumbnailImg.alt = `Thumbnail for ${video.filename}`;
        thumbnailImg.onerror = function () {
          // Fallback if thumbnail fails to load
          this.style.display = "none";
          const placeholder = document.createElement("div");
          placeholder.className = "placeholder";
          placeholder.textContent = "🎬";
          thumbnailDiv.appendChild(placeholder);
        };
        thumbnailDiv.appendChild(thumbnailImg);
      } else {
        // Show placeholder
        const placeholder = document.createElement("div");
        placeholder.className = "placeholder";
        placeholder.textContent = "🎬";
        thumbnailDiv.appendChild(placeholder);
      }

      thumbnailDiv.appendChild(playOverlay);

      const videoInfo = document.createElement("div");
      videoInfo.className = "video-info";

      const videoLink = document.createElement("a");
      videoLink.href = `/video/${encodeURIComponent(video.filename)}`;
      videoLink.target = "_blank";
      videoLink.className = "video-title";
      videoLink.textContent = video.filename;

      videoInfo.appendChild(videoLink);

      // --- Action Buttons (New) ---
      const actionButtonsDiv = document.createElement("div");
      actionButtonsDiv.className = "video-actions";

      const editBtn = document.createElement("button");
      editBtn.className = "action-btn edit-btn";
      editBtn.innerHTML = "✏️ Edit";
      editBtn.title = "Rename Video";
      editBtn.onclick = (e) => {
        e.stopPropagation(); // Prevent opening video link
        renameVideo(video.filename);
      };

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "action-btn delete-btn";
      deleteBtn.innerHTML = "🗑️ Delete";
      deleteBtn.title = "Delete Video";
      deleteBtn.onclick = (e) => {
        e.stopPropagation(); // Prevent opening video link
        deleteVideo(video.filename);
      };

      actionButtonsDiv.appendChild(editBtn);
      actionButtonsDiv.appendChild(deleteBtn);
      videoInfo.appendChild(actionButtonsDiv);
      // --- End Action Buttons ---

      // Make entire video item clickable
      videoItem.addEventListener("click", (e) => {
        // Only open video if a button wasn't clicked
        if (!e.target.closest(".action-btn")) {
          videoLink.click();
        }
      });

      videoItem.appendChild(thumbnailDiv);
      videoItem.appendChild(videoInfo);
      container.appendChild(videoItem);
    });
  } catch (error) {
    console.error("Error loading videos:", error);
    showNotification(`❌ Error loading video list: ${error.message}`, true);
  }
}

// Load videos on page load
loadVideos();
