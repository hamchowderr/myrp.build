fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'myRP.build'
description 'myRP.build Bridge -- companion resource for auto-refresh and resource management'
version '1.0.0'

server_scripts {
    'server/main.lua'
}

convar_category 'myRP.build' {
    'Bridge Settings',
    {
        { 'Controls access to the bridge API', '$myrpbuild_token', 'CV_STRING', '' },
    }
}
