// Bokeh depth of field (gather, after the approach of Unity's Post-processing Stack v2):
//   0 prefilter: half resolution colour + circle of confusion (CoC, signed: + behind focus, − in front)
//   1 bokeh: disc gather, separate background / foreground so blur spills over edges correctly
//   2 postfilter: small tent to smooth the gather
//   3 combine: full resolution, blend by CoC
// CoC is measured in screen heights, so the look is the same at any picture size (stills supersample).
Shader "Hidden/KeyframeStudio/Dof"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
    }
    CGINCLUDE
    #include "KfCommon.cginc"

    sampler2D_float _CameraDepthTexture;
    sampler2D _KfDofTex;
    float4 _KfDof; // x focus distance (m), y blur strength, z max CoC (screen heights), w blur in front (0/1)

    float CoC(float2 uvDepth)
    {
        float d = LinearEyeDepth(SAMPLE_DEPTH_TEXTURE(_CameraDepthTexture, uvDepth));
        float coc = (d - _KfDof.x) / max(d, 1e-3) * _KfDof.y;
        if (_KfDof.w < 0.5) coc = max(coc, 0);
        return clamp(coc, -1, 1) * _KfDof.z;
    }

    // 0 — prefilter (destination is half size)
    fixed4 FragPrefilter(v2f i) : SV_Target
    {
        float3 o = _MainTex_TexelSize.xyx * float3(0.5, 0.5, -0.5);
        float3 c = (tex2D(_MainTex, i.uv - o.xy).rgb + tex2D(_MainTex, i.uv - o.zy).rgb + tex2D(_MainTex, i.uv + o.zy).rgb + tex2D(_MainTex, i.uv + o.xy).rgb) * 0.25;
        return float4(c, CoC(i.uvDepth));
    }

    // 1 — bokeh gather
    #define KF_SAMPLES 48
    fixed4 FragBokeh(v2f i) : SV_Target
    {
        float4 s0 = tex2D(_MainTex, i.uv);
        float aspect = _MainTex_TexelSize.w / _MainTex_TexelSize.z; // height / width
        float margin = _MainTex_TexelSize.y * 2;
        float4 bg = 0, fg = 0;
        [loop]
        for (int k = 0; k < KF_SAMPLES; k++)
        {
            // golden-angle spiral: an even disc
            float r = sqrt((k + 0.5) / KF_SAMPLES);
            float a = k * 2.39996323;
            float2 disp = float2(cos(a), sin(a)) * r * _KfDof.z;
            float dist = length(disp);
            float4 s = tex2D(_MainTex, i.uv + float2(disp.x * aspect, disp.y));
            float bgCoC = max(min(s0.a, s.a), 0);
            float bgW = saturate((bgCoC - dist + margin) / margin);
            float fgW = saturate((-s.a - dist + margin) / margin) * step(_MainTex_TexelSize.y, -s.a);
            bg += float4(s.rgb, 1) * bgW;
            fg += float4(s.rgb, 1) * fgW;
        }
        bg.rgb /= bg.a + (bg.a == 0);
        fg.rgb /= fg.a + (fg.a == 0);
        float fgA = saturate(fg.a * 3.14159265 / KF_SAMPLES);
        return float4(lerp(bg.rgb, fg.rgb, fgA), fgA);
    }

    // 2 — postfilter (9-tap tent)
    fixed4 FragPost(v2f i) : SV_Target
    {
        float4 d = _MainTex_TexelSize.xyxy * float4(-0.5, -0.5, 0.5, 0.5);
        return (tex2D(_MainTex, i.uv + d.xy) + tex2D(_MainTex, i.uv + d.zy) + tex2D(_MainTex, i.uv + d.xw) + tex2D(_MainTex, i.uv + d.zw)) * 0.25;
    }

    // 3 — combine
    fixed4 FragCombine(v2f i) : SV_Target
    {
        fixed4 src = tex2D(_MainTex, i.uv);
        float4 dof = tex2D(_KfDofTex, i.uv);
        float coc = CoC(i.uvDepth);
        float px = abs(_MainTex_TexelSize.y);
        float ffa = smoothstep(px * 2, px * 4, abs(coc));
        float a = ffa + dof.a - ffa * dof.a;
        return fixed4(lerp(src.rgb, dof.rgb, a), src.a);
    }
    ENDCG

    SubShader
    {
        ZTest Always Cull Off ZWrite Off
        Pass { CGPROGRAM
            #pragma vertex vert
            #pragma fragment FragPrefilter
            #pragma target 3.0
            ENDCG }
        Pass { CGPROGRAM
            #pragma vertex vert
            #pragma fragment FragBokeh
            #pragma target 3.0
            #pragma exclude_renderers d3d9
            ENDCG }
        Pass { CGPROGRAM
            #pragma vertex vert
            #pragma fragment FragPost
            #pragma target 3.0
            ENDCG }
        Pass { CGPROGRAM
            #pragma vertex vert
            #pragma fragment FragCombine
            #pragma target 3.0
            ENDCG }
    }
    Fallback Off
}
