#!/bin/bash

#=================================================
# COMMON VARIABLES AND CUSTOM HELPERS
#=================================================

# Copy the HoboPages application code from the package into the install dir.
# Called on install and upgrade.
hobopages_install_app_files() {
    ynh_safe_rm "$install_dir/src"
    mkdir -p "$install_dir/src"
    cp -a ../sources/. "$install_dir/src/"
    chmod +x "$install_dir/deno"
}

# Write the admin password to its own file, readable only by the app user.
hobopages_write_password_file() {
    local password="$1"
    printf '%s' "$password" > "$install_dir/admin_password"
    chmod 600 "$install_dir/admin_password"
    chown "$app:$app" "$install_dir/admin_password"
}

# Apply ownership and permissions across the install dir.
hobopages_fix_permissions() {
    chown -R "$app:$app" "$install_dir"
    chmod 600 "$install_dir/.env"
    chown "$app:$app" "$install_dir/.env"
    if [ -f "$install_dir/admin_password" ]; then
        chmod 600 "$install_dir/admin_password"
        chown "$app:$app" "$install_dir/admin_password"
    fi
    chown -R "$app:$app" "$data_dir"
    chmod 750 "$data_dir"
}
