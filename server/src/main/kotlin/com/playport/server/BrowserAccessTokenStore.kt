package com.playport.server

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions

/** Keeps the browser's access token stable across server restarts. */
object BrowserAccessTokenStore {
    private const val FILE_NAME = "browser-token"
    private val ownerPermissions = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)

    /** An explicit CLI token replaces the saved token and becomes the default for future runs. */
    fun loadOrCreate(stateDir: Path, overrideToken: String? = null): String {
        val file = stateDir.resolve(FILE_NAME)
        if (overrideToken == null && Files.exists(file)) {
            return Files.readString(file).also {
                require(it.isNotBlank()) { "Saved browser access token is blank: $file" }
            }
        }

        val token = overrideToken ?: ServerConfig.generateToken()
        require(token.isNotBlank()) { "Browser access token must not be blank" }
        Files.createDirectories(stateDir)
        val temporary = try {
            Files.createTempFile(stateDir, "$FILE_NAME-", ".tmp", PosixFilePermissions.asFileAttribute(ownerPermissions))
        } catch (_: UnsupportedOperationException) {
            // Non-POSIX filesystems keep default permissions.
            Files.createTempFile(stateDir, "$FILE_NAME-", ".tmp")
        }
        try {
            Files.writeString(temporary, token)
            Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING)
        } finally {
            Files.deleteIfExists(temporary)
        }
        return token
    }
}
