const form = document.getElementById("uploadForm");
const passwordInput = document.getElementById("password");
const progressBar = document.getElementById("progress-bar");
const progressContainer = document.getElementById("progress-container");
const customNameInput = document.getElementById("customName");
const notification = document.getElementById("notification");
const status = document.getElementById("status");
const submitBtn = document.getElementById("submitBtn");
const videoFileInput = document.getElementById("videoFile");
const videoListContainer = document.getElementById("videoList");
const dropZone = document.getElementById("dropZone"); // New: Drop zone element
const dropZoneText = document.getElementById("dropZoneText"); // New: Text inside drop zone
const selectedFileNameSpan = document.getElementById("selectedFileName"); // New: Span for selected file name

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

let sseEventSource = null;

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
  submitBtn.innerHTML =
    '<i class="fas fa-upload"></i> <span>Upload Video</span>';
  progressBar.style.width = "0%";
  progressBar.style.background = "linear-gradient(90deg, #667eea, #764ba2)";
  progressContainer.style.display = "none";
  hideStatus();
  form.reset();
  customNameInput.value = "";
  selectedFileNameSpan.textContent = ""; // Clear selected file name
  dropZone.classList.remove("file-selected"); // Remove file selected class
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

// --- Drag and Drop functionality ---
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    videoFileInput.files = files;
    selectedFileNameSpan.textContent = files[0].name;
    dropZone.classList.add("file-selected");
  }
});

// Update selected file name when file input changes
videoFileInput.addEventListener("change", () => {
  if (videoFileInput.files.length > 0) {
    selectedFileNameSpan.textContent = videoFileInput.files[0].name;
    dropZone.classList.add("file-selected");
  } else {
    selectedFileNameSpan.textContent = "";
    dropZone.classList.remove("file-selected");
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = videoFileInput.files[0];
  if (!file) {
    showNotification("⚠️ Please select a video file.", true);
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML =
    '<span><i class="fas fa-circle-notch fa-spin"></i> Checking Auth...</span>';
  progressContainer.style.display = "block";
  progressBar.style.width = "0%";
  progressBar.style.background = "linear-gradient(90deg, #667eea, #764ba2)";
  showStatus("Checking authentication...", "processing");
  if (sseEventSource) sseEventSource.close();

  const authCheckXhr = new XMLHttpRequest();
  authCheckXhr.open("GET", "/check-auth", true);
  authCheckXhr.setRequestHeader("Authorization", passwordInput.value);

  authCheckXhr.onload = function () {
    if (authCheckXhr.status === 200) {
      startFileUpload(file);
    } else if (authCheckXhr.status === 401) {
      try {
        const response = JSON.parse(authCheckXhr.responseText);
        if (response.error === "MISSING_PASSWORD")
          handleAuthError("MISSING_PASSWORD", "🔒 Please enter a password");
        else if (response.error === "WRONG_PASSWORD")
          handleAuthError("WRONG_PASSWORD", "❌ Wrong password");
        else handleAuthError("AUTH_ERROR", "🚫 Authentication error");
      } catch (parseError) {
        console.error(
          "Auth check parse error:",
          parseError,
          "Response text:",
          authCheckXhr.responseText
        );
        handleAuthError(
          "AUTH_ERROR",
          "🚫 Authentication error (response parse failed)"
        );
      }
      showStatus("❌ Authentication failed", "error");
      progressBar.style.background = "#ef4444";
      resetFormState();
    } else {
      showStatus(
        `Error checking authentication: ${authCheckXhr.statusText}`,
        "error"
      );
      showNotification(
        `❌ Failed to check authentication: ${authCheckXhr.statusText}`,
        true
      );
      progressBar.style.background = "#ef4444";
      resetFormState();
    }
  };

  authCheckXhr.onerror = function () {
    showStatus("❌ Network error during authentication check", "error");
    showNotification("🔌 Network error during authentication check", true);
    progressBar.style.background = "#ef4444";
    resetFormState();
  };

  authCheckXhr.send();
});

function startFileUpload(file) {
  const formData = new FormData();
  formData.append("video", file);

  const customName = customNameInput.value.trim();
  if (customName) {
    formData.append("customName", customName);
  }

  const xhr = new XMLHttpRequest();

  let uploadUrl;
  if (
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  ) {
    uploadUrl = "/upload";
  } else {
    uploadUrl = "https://uploads.sumi.stageddat.dev/upload";
  }

  xhr.open("POST", uploadUrl, true);
  xhr.setRequestHeader("Authorization", passwordInput.value);

  submitBtn.innerHTML =
    '<span><i class="fas fa-cloud-upload-alt"></i> Uploading...</span>';
  showStatus("Starting upload...", "processing");

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
        submitBtn.innerHTML =
          '<i class="fas fa-upload"></i> <span>Upload Video</span>';
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
        if (response.message === "Upload received, file moved directly.") {
          showStatus("Upload complete. File moved directly.", "success");
          showNotification(`✅ ${response.message}`);
          progressBar.style.width = "100%";
          progressBar.style.background = "#22c55e";
          await loadVideos();
          setTimeout(() => resetFormState(), 2000);
          return;
        }

        showStatus("Upload complete. Initializing processing...", "processing");
        progressBar.style.width = "100%";

        let sseUrl;
        if (
          window.location.hostname === "localhost" ||
          window.location.hostname === "127.0.0.1"
        ) {
          sseUrl = `/processing-status/${response.taskId}`;
        } else {
          sseUrl = `https://sumi.stageddat.dev/processing-status/${response.taskId}`;
        }

        //console.log(`[DEBUG] Connecting to SSE: ${sseUrl}`);
        sseEventSource = new EventSource(sseUrl);

        const sseTimeout = setTimeout(() => {
          if (
            sseEventSource &&
            sseEventSource.readyState !== EventSource.CLOSED
          ) {
            console.error("[SSE] Connection timeout after 30 seconds");
            sseEventSource.close();
            showStatus(
              "⚠️ Status connection timeout. Processing may still be running.",
              "processing"
            );
            showNotification(
              "⚠️ Lost connection to processing status. Please refresh to check if video completed.",
              true
            );
          }
        }, 30000);

        sseEventSource.onopen = function () {
          //console.log("[SSE] Connection opened successfully");
          clearTimeout(sseTimeout);
        };

        sseEventSource.onmessage = function (event) {
          //console.log("[SSE] Message received:", event.data);
          try {
            const progressData = JSON.parse(event.data);

            if (progressData.stage === "started") {
              showStatus("Processing started...", "processing");
            } else if (progressData.stage === "probing") {
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
              clearTimeout(sseTimeout);
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
              loadVideos();
              setTimeout(() => resetFormState(), 2000);
            } else if (progressData.stage === "error") {
              clearTimeout(sseTimeout);
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
          } catch (parseError) {
            console.error(
              "[SSE] Error parsing message:",
              parseError,
              event.data
            );
          }
        };

        sseEventSource.onerror = function (event) {
          clearTimeout(sseTimeout);
          console.error("[SSE] Connection error:", event);

          // Check if this is a connection issue or server issue
          if (sseEventSource.readyState === EventSource.CONNECTING) {
            showStatus("⚠️ Reconnecting to processing status...", "processing");
          } else {
            showStatus("⚠️ Lost connection to processing status", "processing");
            showNotification(
              "⚠️ Connection lost. Processing may still be running. Please refresh to check status.",
              true
            );
            sseEventSource.close();

            // Don't reset form state immediately - give user chance to refresh
            setTimeout(() => {
              if (
                confirm(
                  "Processing status connection lost. Would you like to refresh the page to check if your video completed?"
                )
              ) {
                window.location.reload();
              } else {
                resetFormState();
              }
            }, 3000);
          }
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
}

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
      loadVideos();
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
      loadVideos();
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
        '<div class="no-videos"><i class="fas fa-folder-open"></i> No videos uploaded yet</div>';
      return;
    }

    container.innerHTML = "";

    videos.forEach((video) => {
      const videoItem = document.createElement("div");
      videoItem.className = "video-item";

      const thumbnailDiv = document.createElement("div");
      thumbnailDiv.className = "video-thumbnail";

      const playOverlay = document.createElement("div");
      playOverlay.className = "play-overlay";
      playOverlay.innerHTML = '<i class="fas fa-play"></i>'; // Font Awesome play icon

      if (video.thumbnail) {
        const thumbnailImg = document.createElement("img");
        thumbnailImg.src = `/thumbnail/${encodeURIComponent(video.thumbnail)}`;
        thumbnailImg.alt = `Thumbnail for ${video.filename}`;
        thumbnailImg.onerror = function () {
          this.style.display = "none";
          const placeholder = document.createElement("div");
          placeholder.className = "placeholder";
          placeholder.innerHTML = '<i class="fas fa-video"></i>'; // Font Awesome video icon
          thumbnailDiv.appendChild(placeholder);
        };
        thumbnailDiv.appendChild(thumbnailImg);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "placeholder";
        placeholder.innerHTML = '<i class="fas fa-video"></i>'; // Font Awesome video icon
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

      const actionButtonsDiv = document.createElement("div");
      actionButtonsDiv.className = "video-actions";

      const editBtn = document.createElement("button");
      editBtn.className = "action-btn edit-btn";
      editBtn.innerHTML = '<i class="fas fa-edit"></i> Edit'; // Font Awesome edit icon
      editBtn.title = "Rename Video";
      editBtn.onclick = (e) => {
        e.stopPropagation();
        renameVideo(video.filename);
      };

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "action-btn delete-btn";
      deleteBtn.innerHTML = '<i class="fas fa-trash-alt"></i> Delete'; // Font Awesome delete icon
      deleteBtn.title = "Delete Video";
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        deleteVideo(video.filename);
      };

      actionButtonsDiv.appendChild(editBtn);
      actionButtonsDiv.appendChild(deleteBtn);
      videoInfo.appendChild(actionButtonsDiv);

      videoItem.addEventListener("click", (e) => {
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

loadVideos();
