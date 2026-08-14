"use strict";

const fsExt = require("fs-ext-extra-prebuilt");
const flags = fsExt.constants.LOCKFILE_EXCLUSIVE_LOCK | fsExt.constants.LOCKFILE_FAIL_IMMEDIATELY;

function lockFileEx(fd) {
  fsExt.lockFileExSync(fd, flags, 0, 0, 0xffffffff, 0);
}

function unlockFileEx(fd) {
  fsExt.unlockFileExSync(fd, 0, 0, 0xffffffff, 0);
}

module.exports = { lockFileEx, unlockFileEx };
