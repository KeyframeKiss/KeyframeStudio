// Contrast-adaptive sharpening (after AMD's CAS idea): sharpens detail, holds back where edges are already strong.
Shader "Hidden/KeyframeStudio/Sharpen"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
    }
    SubShader
    {
        ZTest Always Cull Off ZWrite Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "KfCommon.cginc"

            float _KfSharpness; // 0..1
            float _KfPixelScale; // render pixels per screen pixel (supersampled stills): sharpen at the size it's seen

            fixed4 frag(v2f i) : SV_Target
            {
                float2 px = abs(_MainTex_TexelSize.xy) * max(1, _KfPixelScale);
                fixed4 e = tex2D(_MainTex, i.uv);
                float3 b = tex2D(_MainTex, i.uv + float2(0, -px.y)).rgb;
                float3 d = tex2D(_MainTex, i.uv + float2(-px.x, 0)).rgb;
                float3 f = tex2D(_MainTex, i.uv + float2(px.x, 0)).rgb;
                float3 h = tex2D(_MainTex, i.uv + float2(0, px.y)).rgb;

                float3 mn = min(e.rgb, min(min(b, d), min(f, h)));
                float3 mx = max(e.rgb, max(max(b, d), max(f, h)));
                // amount from how much headroom there is before clipping
                float3 amp = saturate(min(mn, 1 - mx) / max(mx, 1e-4));
                amp = sqrt(amp);
                float peak = -1.0 / lerp(8.0, 5.0, saturate(_KfSharpness));
                float3 w = amp * peak;
                float3 c = (e.rgb + (b + d + f + h) * w) / (1 + 4 * w);
                return fixed4(saturate(c), e.a);
            }
            ENDCG
        }
    }
    Fallback Off
}
